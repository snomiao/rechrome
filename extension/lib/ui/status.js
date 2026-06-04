import { c as clientExports, j as jsxRuntimeExports, r as reactExports, B as Button, T as TabItem, A as AuthTokenSection } from "./authToken.js";
const StatusApp = () => {
  const [connectedTabs, setConnectedTabs] = reactExports.useState([]);
  const [clientName, setClientName] = reactExports.useState(void 0);
  reactExports.useEffect(() => {
    void loadStatus();
  }, []);
  const loadStatus = async () => {
    const { connectedTabIds, clientName: clientName2 } = await chrome.runtime.sendMessage({ type: "getConnectionStatus" });
    const tabs = await Promise.all((connectedTabIds ?? []).map((tabId) => chrome.tabs.get(tabId)));
    setConnectedTabs(tabs);
    setClientName(clientName2);
  };
  const openTab = async (tabId) => {
    await chrome.tabs.update(tabId, { active: true });
    window.close();
  };
  const disconnect = async () => {
    await chrome.runtime.sendMessage({ type: "disconnect" });
    window.close();
  };
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "app-container", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "content-wrapper", children: [
    connectedTabs.length > 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "connection-header", children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "client-info", children: [
          "Connected to ",
          /* @__PURE__ */ jsxRuntimeExports.jsxs("strong", { children: [
            '"',
            clientName || "unknown",
            '"'
          ] })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", onClick: disconnect, children: "Disconnect" })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "tab-section-title", children: connectedTabs.length === 1 ? "Accessible page:" : "Accessible pages:" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { children: connectedTabs.map((tab) => /* @__PURE__ */ jsxRuntimeExports.jsx(
        TabItem,
        {
          tab,
          onClick: () => openTab(tab.id)
        },
        tab.id
      )) })
    ] }) : /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "status-banner", children: "No clients are currently connected. You can connect from the Playwright CLI or MCP server by passing the --extension flag." }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(AuthTokenSection, {})
  ] }) });
};
const container = document.getElementById("root");
if (container) {
  const root = clientExports.createRoot(container);
  root.render(/* @__PURE__ */ jsxRuntimeExports.jsx(StatusApp, {}));
}
