function debugLog(...args) {
  {
    console.log("[Extension]", ...args);
  }
}
class RelayConnection {
  _debuggee;
  _ws;
  _eventListener;
  _detachListener;
  _tabPromise;
  _tabPromiseResolve;
  _closed = false;
  _playwrightTabIds = /* @__PURE__ */ new Set();
  onclose;
  onPlaywrightTabCreated;
  onPlaywrightTabRemoved;
  constructor(ws) {
    this._debuggee = {};
    this._tabPromise = new Promise((resolve) => this._tabPromiseResolve = resolve);
    this._ws = ws;
    this._ws.onmessage = this._onMessage.bind(this);
    this._ws.onclose = () => this._onClose();
    this._eventListener = this._onDebuggerEvent.bind(this);
    this._detachListener = this._onDebuggerDetach.bind(this);
    chrome.debugger.onEvent.addListener(this._eventListener);
    chrome.debugger.onDetach.addListener(this._detachListener);
  }
  // Either setTabId or close is called after creating the connection.
  setTabId(tabId) {
    this._debuggee = { tabId };
    this._tabPromiseResolve();
  }
  close(message) {
    this._ws.close(1e3, message);
    this._onClose();
  }
  _onClose() {
    if (this._closed)
      return;
    this._closed = true;
    chrome.debugger.onEvent.removeListener(this._eventListener);
    chrome.debugger.onDetach.removeListener(this._detachListener);
    chrome.debugger.detach(this._debuggee).catch(() => {
    });
    for (const tabId of this._playwrightTabIds)
      chrome.debugger.detach({ tabId }).catch(() => {
      });
    this._playwrightTabIds.clear();
    this.onclose?.();
  }
  _onDebuggerEvent(source, method, params) {
    const isInitialTab = source.tabId === this._debuggee.tabId;
    const isPlaywrightTab = source.tabId !== void 0 && this._playwrightTabIds.has(source.tabId);
    if (!isInitialTab && !isPlaywrightTab)
      return;
    debugLog("Forwarding CDP event:", method, params);
    const sessionId = source.sessionId;
    const tabId = isPlaywrightTab ? source.tabId : void 0;
    this._sendMessage({
      method: "forwardCDPEvent",
      params: {
        sessionId,
        method,
        params,
        tabId
      }
    });
  }
  _onDebuggerDetach(source, reason) {
    if (source.tabId !== void 0 && this._playwrightTabIds.has(source.tabId)) {
      debugLog("Playwright tab detached:", source.tabId, reason);
      this._playwrightTabIds.delete(source.tabId);
      this.onPlaywrightTabRemoved?.(source.tabId);
      return;
    }
    if (source.tabId !== this._debuggee.tabId)
      return;
    this.close(`Debugger detached: ${reason}`);
    this._debuggee = {};
  }
  _onMessage(event) {
    this._onMessageAsync(event).catch((e) => debugLog("Error handling message:", e));
  }
  async _onMessageAsync(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      debugLog("Error parsing message:", error);
      this._sendError(-32700, `Error parsing message: ${error.message}`);
      return;
    }
    debugLog("Received message:", message);
    const response = {
      id: message.id
    };
    try {
      response.result = await this._handleCommand(message);
    } catch (error) {
      debugLog("Error handling command:", error);
      response.error = error.message;
    }
    debugLog("Sending response:", response);
    this._sendMessage(response);
  }
  async _handleCommand(message) {
    if (message.method === "attachToTab") {
      await this._tabPromise;
      debugLog("Attaching debugger to tab:", this._debuggee);
      await chrome.debugger.attach(this._debuggee, "1.3");
      const result = await chrome.debugger.sendCommand(this._debuggee, "Target.getTargetInfo");
      return {
        targetInfo: result?.targetInfo,
        tabId: this._debuggee.tabId
      };
    }
    if (message.method === "createTab") {
      const url = message.params?.url ?? "about:blank";
      debugLog("Creating new tab:", url);
      const tab = await chrome.tabs.create({ url, active: true });
      const tabId = tab.id;
      await new Promise((resolve) => setTimeout(resolve, 300));
      await chrome.debugger.attach({ tabId }, "1.3");
      const result = await chrome.debugger.sendCommand({ tabId }, "Target.getTargetInfo");
      const targetInfo = result?.targetInfo || {
        targetId: String(tabId),
        type: "page",
        title: "",
        url: tab.url || url,
        attached: false,
        canAccessOpener: false
      };
      this._playwrightTabIds.add(tabId);
      this.onPlaywrightTabCreated?.(tabId);
      debugLog("Created playwright tab:", tabId, targetInfo);
      return { tabId, targetInfo };
    }
    if (!this._debuggee.tabId)
      throw new Error("No tab is connected. Please go to the Playwright MCP extension and select the tab you want to connect to.");
    if (message.method === "forwardCDPCommand") {
      const { sessionId, method, params, tabId } = message.params;
      debugLog("CDP command:", method, params, "tabId:", tabId);
      const debuggee = tabId !== void 0 ? { tabId, sessionId } : { ...this._debuggee, sessionId };
      return await chrome.debugger.sendCommand(debuggee, method, params);
    }
  }
  _sendError(code, message) {
    this._sendMessage({
      error: {
        code,
        message
      }
    });
  }
  _sendMessage(message) {
    if (this._ws.readyState === WebSocket.OPEN)
      this._ws.send(JSON.stringify(message));
  }
}
class TabShareExtension {
  _connections = /* @__PURE__ */ new Map();
  _pendingTabSelection = /* @__PURE__ */ new Map();
  constructor() {
    chrome.tabs.onRemoved.addListener(this._onTabRemoved.bind(this));
    chrome.tabs.onUpdated.addListener(this._onTabUpdated.bind(this));
    chrome.tabs.onActivated.addListener(this._onTabActivated.bind(this));
    chrome.runtime.onMessage.addListener(this._onMessage.bind(this));
    chrome.action.onClicked.addListener(this._onActionClicked.bind(this));
  }
  // Promise-based message handling is not supported in Chrome: https://issues.chromium.org/issues/40753031
  _onMessage(message, sender, sendResponse) {
    switch (message.type) {
      case "connectToMCPRelay":
        this._connectToRelay(sender.tab.id, message.mcpRelayUrl).then(
          () => sendResponse({ success: true }),
          (error) => sendResponse({ success: false, error: error.message })
        );
        return true;
      case "getTabs":
        this._getTabs().then(
          (tabs) => sendResponse({ success: true, tabs, currentTabId: sender.tab?.id }),
          (error) => sendResponse({ success: false, error: error.message })
        );
        return true;
      case "connectToTab":
        const tabId = message.tabId || sender.tab?.id;
        const windowId = message.windowId || sender.tab?.windowId;
        this._connectTab(sender.tab.id, tabId, windowId, message.mcpRelayUrl).then(
          () => sendResponse({ success: true }),
          (error) => sendResponse({ success: false, error: error.message })
        );
        return true;
      // Return true to indicate that the response will be sent asynchronously
      case "getConnectionStatus":
        sendResponse({
          connections: [...this._connections.values()].map((s) => ({
            mcpRelayUrl: s.mcpRelayUrl,
            connectedTabId: s.connectedTabId,
            playwrightTabIds: [...s.playwrightTabIds]
          })),
          // Legacy fields for backward compat: first connection's tabId
          connectedTabId: [...this._connections.values()][0]?.connectedTabId ?? null,
          playwrightTabIds: [...this._connections.values()].flatMap((s) => [...s.playwrightTabIds])
        });
        return false;
      case "disconnect":
        this._disconnect(message.mcpRelayUrl).then(
          () => sendResponse({ success: true }),
          (error) => sendResponse({ success: false, error: error.message })
        );
        return true;
    }
    return false;
  }
  async _connectToRelay(selectorTabId, mcpRelayUrl) {
    try {
      debugLog(`Connecting to relay at ${mcpRelayUrl}`);
      const socket = new WebSocket(mcpRelayUrl);
      await new Promise((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error("WebSocket error"));
        setTimeout(() => reject(new Error("Connection timeout")), 5e3);
      });
      const connection = new RelayConnection(socket);
      connection.onclose = () => {
        debugLog("Connection closed");
        this._pendingTabSelection.delete(selectorTabId);
      };
      this._pendingTabSelection.set(selectorTabId, { connection, mcpRelayUrl });
      debugLog(`Connected to MCP relay`);
    } catch (error) {
      const message = `Failed to connect to MCP relay: ${error.message}`;
      debugLog(message);
      throw new Error(message);
    }
  }
  async _connectTab(selectorTabId, tabId, windowId, mcpRelayUrl) {
    try {
      debugLog(`Connecting tab ${tabId} to relay at ${mcpRelayUrl}`);
      const pending = this._pendingTabSelection.get(selectorTabId);
      if (!pending)
        throw new Error("No active MCP relay connection");
      this._pendingTabSelection.delete(selectorTabId);
      const connection = pending.connection;
      const relayUrl = pending.mcpRelayUrl;
      const existing = this._connections.get(relayUrl);
      if (existing) {
        existing.connection.close("Another connection is requested");
        this._connections.delete(relayUrl);
      }
      const state = {
        connection,
        connectedTabId: tabId,
        playwrightTabIds: /* @__PURE__ */ new Set(),
        mcpRelayUrl: relayUrl
      };
      this._connections.set(relayUrl, state);
      connection.setTabId(tabId);
      connection.onclose = () => {
        debugLog("MCP connection closed");
        if (this._connections.get(relayUrl)?.connection === connection)
          this._connections.delete(relayUrl);
        void this._updateBadge(state.connectedTabId, { text: "" });
        for (const pwTabId of state.playwrightTabIds)
          void this._updateBadge(pwTabId, { text: "" });
        state.playwrightTabIds.clear();
      };
      connection.onPlaywrightTabCreated = (pwTabId) => {
        state.playwrightTabIds.add(pwTabId);
        void this._updateBadge(pwTabId, { text: "✓", color: "#1976D2", title: "Playwright managed tab" });
      };
      connection.onPlaywrightTabRemoved = (pwTabId) => {
        state.playwrightTabIds.delete(pwTabId);
        void this._updateBadge(pwTabId, { text: "" });
      };
      await Promise.all([
        this._updateBadge(tabId, { text: "✓", color: "#4CAF50", title: "Connected to MCP client" }),
        chrome.tabs.update(tabId, { active: true }),
        chrome.windows.update(windowId, { focused: true })
      ]);
      debugLog(`Connected to MCP bridge`);
    } catch (error) {
      debugLog(`Failed to connect tab ${tabId}:`, error.message);
      throw error;
    }
  }
  async _updateBadge(tabId, { text, color, title }) {
    try {
      await chrome.action.setBadgeText({ tabId, text });
      await chrome.action.setTitle({ tabId, title: title || "" });
      if (color)
        await chrome.action.setBadgeBackgroundColor({ tabId, color });
    } catch (error) {
    }
  }
  async _onTabRemoved(tabId) {
    const pendingConnection = [...this._pendingTabSelection.entries()].find(([k]) => k === tabId)?.[1];
    if (pendingConnection) {
      this._pendingTabSelection.delete(tabId);
      pendingConnection.connection.close("Browser tab closed");
      return;
    }
    for (const [relayUrl, state] of this._connections) {
      if (state.playwrightTabIds.has(tabId)) {
        state.playwrightTabIds.delete(tabId);
        return;
      }
      if (state.connectedTabId === tabId) {
        state.connection.close("Browser tab closed");
        this._connections.delete(relayUrl);
        return;
      }
    }
  }
  _onTabActivated(activeInfo) {
    for (const [tabId, pending] of this._pendingTabSelection) {
      if (tabId === activeInfo.tabId) {
        if (pending.timerId) {
          clearTimeout(pending.timerId);
          pending.timerId = void 0;
        }
        continue;
      }
      if (!pending.timerId) {
        pending.timerId = setTimeout(() => {
          const existed = this._pendingTabSelection.delete(tabId);
          if (existed) {
            pending.connection.close("Tab has been inactive for 5 seconds");
            chrome.tabs.sendMessage(tabId, { type: "connectionTimeout" });
          }
        }, 5e3);
      }
    }
  }
  _onTabUpdated(tabId, changeInfo, tab) {
    for (const state of this._connections.values()) {
      if (state.connectedTabId === tabId)
        void this._updateBadge(tabId, { text: "✓", color: "#4CAF50", title: "Connected to MCP client" });
      if (state.playwrightTabIds.has(tabId))
        void this._updateBadge(tabId, { text: "✓", color: "#1976D2", title: "Playwright managed tab" });
    }
  }
  async _getTabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((tab) => tab.url && !["chrome:", "edge:", "devtools:"].some((scheme) => tab.url.startsWith(scheme)));
  }
  async _onActionClicked() {
    await chrome.tabs.create({
      url: chrome.runtime.getURL("status.html"),
      active: true
    });
  }
  async _disconnect(mcpRelayUrl) {
    if (mcpRelayUrl) {
      const state = this._connections.get(mcpRelayUrl);
      if (state) {
        state.connection.close("User disconnected");
        this._connections.delete(mcpRelayUrl);
      }
    } else {
      for (const state of this._connections.values())
        state.connection.close("User disconnected");
      this._connections.clear();
    }
  }
}
new TabShareExtension();
