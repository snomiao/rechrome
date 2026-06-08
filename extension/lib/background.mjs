var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class ProtocolV1Handler {
  constructor(context) {
    __publicField(this, "_context");
    __publicField(this, "_selectedTabPromise");
    __publicField(this, "_selectedTabResolve");
    this._context = context;
    this._selectedTabPromise = new Promise((resolve) => this._selectedTabResolve = resolve);
  }
  async handleCommand(message) {
    if (message.method === "attachToTab") {
      const tabId = await this._selectedTabPromise;
      const debuggee = { tabId };
      await chrome.debugger.attach(debuggee, "1.3");
      this._context.notifyTabAttached(tabId);
      const result = await chrome.debugger.sendCommand(debuggee, "Target.getTargetInfo");
      return { targetInfo: result == null ? void 0 : result.targetInfo };
    }
    if (message.method === "forwardCDPCommand") {
      const { sessionId, method, params } = message.params;
      if (method === "Target.createTarget")
        throw new Error("Tab creation is not supported yet. Update Playwright MCP or CLI to the latest version.");
      const tabId = [...this._context.attachedTabs][0];
      if (tabId === void 0)
        throw new Error("No tab is connected");
      const debuggerSession = { tabId, sessionId };
      return await chrome.debugger.sendCommand(debuggerSession, method, params);
    }
    throw new Error(`Unknown method: ${message.method}`);
  }
  forwardChromeEvent(fullMethod, args) {
    if (fullMethod !== "chrome.debugger.onEvent")
      return;
    const [source, method, params] = args;
    this._context.sendMessage({
      method: "forwardCDPEvent",
      params: { sessionId: source.sessionId, method, params }
    });
  }
  onUserAttachRequest(tab) {
    if (tab.id !== void 0)
      this._selectedTabResolve(tab.id);
  }
  onUserDetachRequest(_tabId) {
  }
  didInitialize() {
  }
}
const ALLOWED_CHROME_COMMANDS = /* @__PURE__ */ new Set([
  "chrome.debugger.attach",
  "chrome.debugger.detach",
  "chrome.debugger.sendCommand",
  "chrome.tabs.create",
  "chrome.tabs.remove"
]);
class ProtocolV2Handler {
  constructor(context) {
    __publicField(this, "_context");
    this._context = context;
  }
  async handleCommand(message) {
    if (ALLOWED_CHROME_COMMANDS.has(message.method)) {
      const args = message.params ?? [];
      const result = await invokeChromeMethod(message.method, args);
      if (message.method === "chrome.debugger.attach") {
        const target = args[0];
        if ((target == null ? void 0 : target.tabId) !== void 0)
          this._context.notifyTabAttached(target.tabId);
      }
      return result ?? {};
    }
    throw new Error(`Unknown method: ${message.method}`);
  }
  forwardChromeEvent(fullMethod, args) {
    this._context.sendMessage({ method: fullMethod, params: args });
  }
  onUserAttachRequest(tab) {
    this._context.sendMessage({ method: "chrome.tabs.onCreated", params: [tab] });
  }
  didInitialize() {
    this._context.sendMessage({ method: "extension.initialized", params: [] });
  }
  onUserDetachRequest(tabId) {
    this._context.sendMessage({
      method: "chrome.debugger.onDetach",
      params: [{ tabId }, "target_closed"]
    });
  }
}
function resolveChromeMember(fullMethod) {
  const parts = fullMethod.split(".");
  if (parts[0] !== "chrome" || parts.length < 3)
    throw new Error(`Invalid chrome method: ${fullMethod}`);
  let obj = chrome;
  for (let i = 1; i < parts.length - 1; i++) {
    obj = obj == null ? void 0 : obj[parts[i]];
    if (obj === void 0)
      throw new Error(`Unknown chrome path: ${parts.slice(0, i + 1).join(".")}, calling ${fullMethod}`);
  }
  return { obj, name: parts[parts.length - 1] };
}
async function invokeChromeMethod(fullMethod, args) {
  const { obj, name } = resolveChromeMember(fullMethod);
  const fn = obj[name];
  if (typeof fn !== "function")
    throw new Error(`Not a function: ${fullMethod}`);
  return await fn.apply(obj, args);
}
function debugLog(...args) {
  {
    console.log("[Extension]", ...args);
  }
}
const CHROME_EVENT_METHODS = [
  "chrome.debugger.onEvent",
  "chrome.debugger.onDetach",
  "chrome.tabs.onCreated",
  "chrome.tabs.onRemoved"
];
class RelayConnection {
  constructor(ws, protocolVersion) {
    __publicField(this, "_ws");
    __publicField(this, "_handler");
    // Tabs whose debugger we have explicitly attached for this connection.
    __publicField(this, "_attachedTabs", /* @__PURE__ */ new Set());
    // Once we've attached at least one tab, detaching the last one closes the connection.
    __publicField(this, "_hasEverAttached", false);
    __publicField(this, "_eventListeners", []);
    __publicField(this, "_closed", false);
    __publicField(this, "onclose");
    __publicField(this, "ontabattached");
    __publicField(this, "ontabdetached");
    this._ws = ws;
    const context = {
      attachedTabs: this._attachedTabs,
      sendMessage: (msg) => this._sendMessage(msg),
      notifyTabAttached: (tabId) => this._notifyTabAttached(tabId),
      notifyTabDetached: (tabId) => this._notifyTabDetached(tabId)
    };
    this._handler = protocolVersion === 1 ? new ProtocolV1Handler(context) : new ProtocolV2Handler(context);
    this._installEventForwarders();
    this._ws.onmessage = this._onMessage.bind(this);
    this._ws.onclose = () => this._onClose();
  }
  get attachedTabs() {
    return this._attachedTabs;
  }
  // Signals the end of the initial-tab handshake — call after the initial
  // round of `attachTab` invocations. For v2 this sends `extension.initialized`
  // so the relay can unblock Playwright CDP traffic; v1 has no handshake.
  didInitialize() {
    this._handler.didInitialize();
  }
  close(message) {
    this._ws.close(1e3, message);
    this._onClose();
  }
  // Called when the UI adds a tab to the Playwright group. The handler asks
  // the relay to attach; the normal command path fires ontabattached.
  attachTab(tab) {
    if (this._closed || this._attachedTabs.has(tab.id))
      return;
    this._handler.onUserAttachRequest(tab);
  }
  // Called when the UI removes a tab from the Playwright group. We detach the
  // debugger and update bookkeeping; the handler emits the wire-level detach
  // notification for protocols that have one.
  detachTab(tabId) {
    if (this._closed || !this._attachedTabs.has(tabId))
      return;
    chrome.debugger.detach({ tabId }).catch((error) => {
      debugLog("Error detaching tab:", error);
    });
    this._notifyTabDetached(tabId);
    this._handler.onUserDetachRequest(tabId);
    this._checkLastTabDetached();
  }
  _notifyTabAttached(tabId) {
    var _a;
    this._attachedTabs.add(tabId);
    this._hasEverAttached = true;
    (_a = this.ontabattached) == null ? void 0 : _a.call(this, tabId);
  }
  _notifyTabDetached(tabId) {
    var _a;
    this._attachedTabs.delete(tabId);
    (_a = this.ontabdetached) == null ? void 0 : _a.call(this, tabId);
  }
  _installEventForwarders() {
    for (const fullMethod of CHROME_EVENT_METHODS) {
      const target = resolveChromeMember(fullMethod);
      const listener = (...args) => this._onChromeEvent(fullMethod, args);
      target.obj[target.name].addListener(listener);
      this._eventListeners.push({
        remove: () => target.obj[target.name].removeListener(listener)
      });
    }
  }
  _onClose() {
    var _a;
    if (this._closed)
      return;
    this._closed = true;
    for (const l of this._eventListeners)
      l.remove();
    this._eventListeners = [];
    for (const tabId of [...this._attachedTabs]) {
      chrome.debugger.detach({ tabId }).catch(() => {
      });
      this._notifyTabDetached(tabId);
    }
    (_a = this.onclose) == null ? void 0 : _a.call(this);
  }
  _checkLastTabDetached() {
    if (this._hasEverAttached && this._attachedTabs.size === 0)
      this.close("All controlled tabs detached");
  }
  // Filters chrome.* events to attached tabs, delegates wire formatting to the
  // handler, then runs shared detach bookkeeping.
  _onChromeEvent(fullMethod, args) {
    const tabId = this._tabIdForEventArgs(fullMethod, args);
    if (tabId === void 0 || !this._attachedTabs.has(tabId))
      return;
    this._handler.forwardChromeEvent(fullMethod, args);
    if (fullMethod === "chrome.debugger.onDetach") {
      this._notifyTabDetached(tabId);
      this._checkLastTabDetached();
    }
  }
  // Returns the tabId an event refers to, for filtering by _attachedTabs.
  _tabIdForEventArgs(fullMethod, args) {
    var _a;
    switch (fullMethod) {
      case "chrome.debugger.onEvent":
      case "chrome.debugger.onDetach":
        return (_a = args[0]) == null ? void 0 : _a.tabId;
      case "chrome.tabs.onCreated": {
        const tab = args[0];
        return tab.openerTabId;
      }
      case "chrome.tabs.onRemoved":
        return args[0];
    }
    return void 0;
  }
  _onMessage(event) {
    this._onMessageAsync(event).catch((e) => debugLog("Error handling message:", e));
  }
  async _onMessageAsync(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      debugLog(`Error parsing message ${event.data}:`, error);
      this._sendError(-32700, `Error parsing message: ${error.message}`);
      return;
    }
    const response = {
      id: message.id
    };
    try {
      response.result = await this._handler.handleCommand(message);
    } catch (error) {
      debugLog(`Error handling command ${JSON.stringify(message)}:`, error);
      response.error = error.message;
    }
    this._sendMessage(response);
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
class EagerPending {
  constructor(connection) {
    __publicField(this, "_connection");
    __publicField(this, "onclose");
    this._connection = connection;
    this._connection.onclose = () => {
      var _a;
      return (_a = this.onclose) == null ? void 0 : _a.call(this);
    };
  }
  static async create(mcpRelayUrl, protocolVersion) {
    const connection = await openRelayConnection(mcpRelayUrl, protocolVersion);
    return new EagerPending(connection);
  }
  async connect() {
    return this._connection;
  }
  close(reason) {
    this._connection.close(reason);
  }
}
class DeferredPending {
  constructor(_mcpRelayUrl, _protocolVersion) {
    this._mcpRelayUrl = _mcpRelayUrl;
    this._protocolVersion = _protocolVersion;
  }
  async connect() {
    return openRelayConnection(this._mcpRelayUrl, this._protocolVersion);
  }
  close(_reason) {
  }
}
class PendingConnections {
  constructor() {
    __publicField(this, "_map", /* @__PURE__ */ new Map());
    chrome.tabs.onRemoved.addListener(this._onTabRemoved.bind(this));
  }
  // v1 opens the relay WS eagerly — the daemon expects a prompt connection.
  // v2 records only the descriptor; the WS opens lazily in `take` once the
  // user clicks Allow.
  async create(selectorTabId, mcpRelayUrl, protocolVersion) {
    if (protocolVersion !== 1) {
      this._map.set(selectorTabId, new DeferredPending(mcpRelayUrl, protocolVersion));
      return;
    }
    const entry = await EagerPending.create(mcpRelayUrl, protocolVersion);
    entry.onclose = () => {
      if (this._map.get(selectorTabId) !== entry)
        return;
      this._map.delete(selectorTabId);
      chrome.tabs.sendMessage(selectorTabId, { type: "pendingConnectionClosed" }).catch(() => {
      });
    };
    this._map.set(selectorTabId, entry);
  }
  async take(selectorTabId) {
    const entry = this._map.get(selectorTabId);
    if (!entry)
      return void 0;
    this._map.delete(selectorTabId);
    return entry.connect();
  }
  _onTabRemoved(tabId) {
    const entry = this._map.get(tabId);
    if (!entry)
      return;
    this._map.delete(tabId);
    entry.close("Browser tab closed");
  }
}
async function openRelayConnection(mcpRelayUrl, protocolVersion) {
  try {
    const socket = new WebSocket(mcpRelayUrl);
    await new Promise((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("WebSocket error"));
      setTimeout(() => reject(new Error("Connection timeout")), 5e3);
    });
    return new RelayConnection(socket, protocolVersion);
  } catch (error) {
    const message = `Failed to connect to MCP relay: ${error.message}`;
    debugLog(message);
    throw new Error(message);
  }
}
const PLAYWRIGHT_GROUP_TITLE = "Playwright";
const PLAYWRIGHT_GROUP_COLOR = "green";
const PLAYWRIGHT_GROUP_MARK = "🎭";
const NON_DEBUGGABLE_SCHEMES = ["chrome:", "edge:", "devtools:"];
const CONNECTED_BADGE = { text: "✓", color: "#4CAF50", title: "Connected to Playwright client" };
function isNonDebuggableUrl(url) {
  return !!url && NON_DEBUGGABLE_SCHEMES.some((s) => url.startsWith(s));
}
function urlDomain(url) {
  if (!url)
    return void 0;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:")
      return void 0;
    return u.hostname.replace(/^www\./, "");
  } catch {
    return void 0;
  }
}
function groupTitle(clientName, seedUrl) {
  return `${PLAYWRIGHT_GROUP_MARK} ${clientName || urlDomain(seedUrl) || PLAYWRIGHT_GROUP_TITLE}`;
}
async function cleanupStalePlaywrightGroups() {
  try {
    const groups = (await chrome.tabGroups.query({})).filter((g) => {
      var _a;
      return (_a = g.title) == null ? void 0 : _a.startsWith(PLAYWRIGHT_GROUP_MARK);
    });
    const tabsPerGroup = await Promise.all(groups.map((g) => chrome.tabs.query({ groupId: g.id })));
    const tabIds = tabsPerGroup.flat().map((t) => t.id).filter((id) => id !== void 0);
    if (tabIds.length)
      await chrome.tabs.ungroup(tabIds);
  } catch (error) {
    debugLog("Error cleaning up stale groups:", error);
  }
}
class ConnectedTabGroup {
  constructor(connection, selectedTab, clientName) {
    __publicField(this, "_connection");
    __publicField(this, "_groupId", null);
    __publicField(this, "_groupTabIds", /* @__PURE__ */ new Set());
    __publicField(this, "_onTabUpdatedListener");
    __publicField(this, "_onTabRemovedListener");
    __publicField(this, "_groupTitle");
    __publicField(this, "onclose");
    this._connection = connection;
    this._groupTitle = groupTitle(clientName, selectedTab.url);
    this._connection.onclose = () => this._onConnectionClose();
    this._connection.ontabattached = (tabId) => this._onTabAttached(tabId);
    this._connection.ontabdetached = (tabId) => this._onTabDetached(tabId);
    this._onTabUpdatedListener = this._onTabUpdated.bind(this);
    this._onTabRemovedListener = this._onTabRemoved.bind(this);
    chrome.tabs.onUpdated.addListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.addListener(this._onTabRemovedListener);
    this._connection.attachTab(selectedTab);
    this._connection.didInitialize();
  }
  connectedTabIds() {
    return [...this._groupTabIds];
  }
  close(reason) {
    this._connection.close(reason);
  }
  _onTabUpdated(tabId, changeInfo, tab) {
    if (changeInfo.groupId !== void 0)
      this._onTabGroupChanged(tabId, tab);
    if (changeInfo.url === void 0)
      return;
    if (this._connection.attachedTabs.has(tabId))
      void this._updateBadge(tabId, CONNECTED_BADGE);
    else if (this._groupTabIds.has(tabId) && !isNonDebuggableUrl(changeInfo.url))
      this._connection.attachTab(tab);
  }
  // Single entry point for group membership changes, whether the user dragged
  // or we grouped the tab ourselves. Attaches on entry (if debuggable) and
  // detaches on exit; a chrome:// tab stays in the group until it navigates
  // (handled in _onTabUpdated).
  _onTabGroupChanged(tabId, tab) {
    const inOurGroup = this._groupId !== null && tab.groupId === this._groupId;
    const wasInGroup = this._groupTabIds.has(tabId);
    if (inOurGroup === wasInGroup)
      return;
    if (inOurGroup) {
      this._groupTabIds.add(tabId);
      if (!isNonDebuggableUrl(tab.url))
        this._connection.attachTab(tab);
    } else {
      this._groupTabIds.delete(tabId);
      if (this._connection.attachedTabs.has(tabId))
        this._connection.detachTab(tabId);
    }
  }
  _onTabRemoved(tabId) {
    this._groupTabIds.delete(tabId);
  }
  _onTabAttached(tabId) {
    void this._updateBadge(tabId, CONNECTED_BADGE);
    void this._addTabToGroup(tabId);
  }
  // The debugger detached (drag-out, tab close, or external action). Clear the
  // badge but leave the tab in the group — the user's intent is still there,
  // and a subsequent navigation will re-attach via _onTabUpdated.
  _onTabDetached(tabId) {
    void this._updateBadge(tabId, { text: "" });
  }
  _onConnectionClose() {
    var _a;
    chrome.tabs.onUpdated.removeListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.removeListener(this._onTabRemovedListener);
    const groupTabs = [...this._groupTabIds];
    this._groupTabIds.clear();
    if (groupTabs.length) {
      this._retryOnDrag(() => chrome.tabs.ungroup(groupTabs)).catch((error) => {
        debugLog("Error ungrouping tabs on close:", error);
      });
    }
    (_a = this.onclose) == null ? void 0 : _a.call(this);
  }
  async _updateBadge(tabId, { text, color, title }) {
    try {
      await Promise.all([
        chrome.action.setBadgeText({ tabId, text }),
        chrome.action.setTitle({ tabId, title: title || "" }),
        color ? chrome.action.setBadgeBackgroundColor({ tabId, color }) : Promise.resolve()
      ]);
    } catch (error) {
    }
  }
  // Moves an already-attached tab into our Chrome tab group, creating it on
  // first use. `_groupTabIds` is updated after the await so an onUpdated event
  // that arrives concurrently (`_groupId` still null, wasInGroup still false)
  // becomes a harmless no-op rather than taking the drag-out branch.
  async _addTabToGroup(tabId) {
    if (this._groupTabIds.has(tabId))
      return;
    try {
      await this._retryOnDrag(async () => {
        if (this._groupId === null) {
          this._groupId = await chrome.tabs.group({ tabIds: [tabId] });
          await chrome.tabGroups.update(this._groupId, { color: PLAYWRIGHT_GROUP_COLOR, title: this._groupTitle });
        } else {
          await chrome.tabs.group({ groupId: this._groupId, tabIds: [tabId] });
        }
      });
      this._groupTabIds.add(tabId);
    } catch (error) {
      debugLog("Error adding tab to group:", error);
    }
  }
  // Chrome throws "user may be dragging a tab" while a drag is in progress.
  // Retry with backoff until it clears (or we give up).
  async _retryOnDrag(fn) {
    var _a;
    const delays = [0, 100, 200, 400, 800];
    let lastError;
    for (const delay of delays) {
      if (delay)
        await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        await fn();
        return;
      } catch (error) {
        if (!((_a = error == null ? void 0 : error.message) == null ? void 0 : _a.includes("user may be dragging a tab")))
          throw error;
        lastError = error;
      }
    }
    throw lastError;
  }
}
class PlaywrightExtension {
  constructor() {
    // Multiple concurrent clients can share one Chrome profile — each connection gets
    // its own ConnectedTabGroup (its own Chrome tab group), so a new client no longer
    // evicts existing ones. Tabs stay isolated by per-group _groupId / attachedTabs.
    __publicField(this, "_activeGroups", /* @__PURE__ */ new Set());
    __publicField(this, "_clientNames", /* @__PURE__ */ new Map());
    __publicField(this, "_pendingConnections", new PendingConnections());
    // Service worker restarts lose all connection state, so any existing
    // Playwright groups are stale. Connections wait on this before reconciling.
    __publicField(this, "_cleanupPromise");
    chrome.runtime.onMessage.addListener(this._onMessage.bind(this));
    chrome.action.onClicked.addListener(this._onActionClicked.bind(this));
    this._cleanupPromise = cleanupStalePlaywrightGroups();
  }
  // Promise-based message handling is not supported in Chrome: https://issues.chromium.org/issues/40753031
  _onMessage(message, sender, sendResponse) {
    switch (message.type) {
      case "connectionRequested":
        this._pendingConnections.create(sender.tab.id, message.mcpRelayUrl, message.protocolVersion).then(
          () => sendResponse({ success: true }),
          (error) => sendResponse({ success: false, error: error.message })
        );
        return true;
      case "getTabs":
        this._getTabs().then(
          (tabs) => {
            var _a;
            return sendResponse({ success: true, tabs, currentTabId: (_a = sender.tab) == null ? void 0 : _a.id });
          },
          (error) => sendResponse({ success: false, error: error.message })
        );
        return true;
      case "connectToTab": {
        const selectedTab = message.tab ?? sender.tab;
        this._connectTab(sender.tab.id, selectedTab, message.clientName).then(
          () => sendResponse({ success: true }),
          (error) => sendResponse({ success: false, error: error.message })
        );
        return true;
      }
      case "getConnectionStatus":
        sendResponse({
          connectedTabIds: [...this._activeGroups].flatMap((group) => group.connectedTabIds()),
          clientName: [...this._clientNames.values()].filter(Boolean).join(", ") || void 0
        });
        return false;
      case "disconnect":
        try {
          this._disconnect("User disconnected");
          sendResponse({ success: true });
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
        return true;
      case "keepalive":
        return false;
    }
  }
  async _connectTab(selectorTabId, tab, clientName) {
    try {
      await this._cleanupPromise;
      const connection = await this._pendingConnections.take(selectorTabId);
      if (!connection)
        throw new Error("Pending client connection closed");
      const group = new ConnectedTabGroup(connection, tab, clientName);
      group.onclose = () => {
        this._activeGroups.delete(group);
        this._clientNames.delete(group);
      };
      this._activeGroups.add(group);
      this._clientNames.set(group, clientName);
      await Promise.all([
        chrome.tabs.update(tab.id, { active: true }),
        chrome.windows.update(tab.windowId, { focused: true })
      ]).catch(() => {
      });
      if (tab.id !== selectorTabId)
        await chrome.tabs.remove(selectorTabId).catch(() => {
        });
    } catch (error) {
      debugLog(`Failed to connect tab ${tab.id}:`, error.message);
      throw error;
    }
  }
  async _getTabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((tab) => !isNonDebuggableUrl(tab.url));
  }
  async _onActionClicked() {
    await chrome.tabs.create({
      url: chrome.runtime.getURL("status.html"),
      active: true
    });
  }
  // Closes every active group's connection. ConnectedTabGroup's onclose handles
  // per-group state cleanup (connectedTabIds, badges, reconcile).
  _disconnect(reason) {
    for (const group of this._activeGroups)
      group.close(reason);
    this._activeGroups.clear();
    this._clientNames.clear();
  }
}
new PlaywrightExtension();
