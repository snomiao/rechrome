import { c as clientExports, j as jsxRuntimeExports, r as reactExports, T as TabItem, B as Button, A as AuthTokenSection } from "./authToken.js";
const StatusApp = () => {
  const [connections, setConnections] = reactExports.useState([]);
  reactExports.useEffect(() => {
    void loadStatus();
  }, []);
  const loadStatus = async () => {
    const { connections: rawConnections = [] } = await chrome.runtime.sendMessage({ type: "getConnectionStatus" });
    const fetchTab = async (id) => {
      try {
        const tab = await chrome.tabs.get(id);
        return { id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl };
      } catch {
        return null;
      }
    };
    const resolved = await Promise.all(
      rawConnections.map(async (c) => {
        const connectedTab = await fetchTab(c.connectedTabId) ?? void 0;
        const playwrightTabs = (await Promise.all(c.playwrightTabIds.map(fetchTab))).filter((t) => t !== null);
        return { ...c, connectedTab, playwrightTabs };
      })
    );
    setConnections(resolved);
  };
  const openTab = async (tabId) => {
    await chrome.tabs.update(tabId, { active: true });
    window.close();
  };
  const disconnect = async (mcpRelayUrl) => {
    await chrome.runtime.sendMessage({ type: "disconnect", mcpRelayUrl });
    void loadStatus();
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "app-container", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "content-wrapper", children: [
    connections.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "status-banner", children: "No MCP clients are currently connected." }) : connections.map((c, i) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
      connections.length > 1 && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "tab-section-title", children: [
        "Instance ",
        i + 1,
        ":"
      ] }),
      c.connectedTab && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "tab-section-title", children: "Page with connected MCP client:" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          TabItem,
          {
            tab: c.connectedTab,
            button: /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", onClick: () => disconnect(c.mcpRelayUrl), children: "Disconnect" }),
            onClick: () => openTab(c.connectedTabId)
          }
        )
      ] }),
      c.playwrightTabs.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "tab-section-title", children: "Playwright managed tabs:" }),
        c.playwrightTabs.map((tab) => /* @__PURE__ */ jsxRuntimeExports.jsx(
          TabItem,
          {
            tab,
            onClick: () => openTab(tab.id)
          },
          tab.id
        ))
      ] })
    ] }, c.mcpRelayUrl)),
    /* @__PURE__ */ jsxRuntimeExports.jsx(AuthTokenSection, {})
  ] }) });
};
const container = document.getElementById("root");
if (container) {
  const root = clientExports.createRoot(container);
  root.render(/* @__PURE__ */ jsxRuntimeExports.jsx(StatusApp, {}));
}
