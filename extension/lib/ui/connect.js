import { c as clientExports, j as jsxRuntimeExports, r as reactExports, A as AuthTokenSection, T as TabItem, B as Button, g as getOrCreateAuthToken } from "./authToken.js";
const SUPPORTED_PROTOCOL_VERSION = 2;
const ConnectApp = () => {
  const [tabs, setTabs] = reactExports.useState([]);
  const [status, setStatus] = reactExports.useState(null);
  const [showTabList, setShowTabList] = reactExports.useState(true);
  const [clientInfo, setClientInfo] = reactExports.useState("unknown");
  const setError = reactExports.useCallback((message) => {
    setShowTabList(false);
    setStatus({ type: "error", message });
  }, []);
  reactExports.useEffect(() => {
    const runAsync = async () => {
      const params = new URLSearchParams(window.location.search);
      const relayUrl = params.get("mcpRelayUrl");
      if (!relayUrl) {
        setError("Missing mcpRelayUrl parameter in URL.");
        return;
      }
      try {
        const host = new URL(relayUrl).hostname;
        if (host !== "127.0.0.1" && host !== "[::1]") {
          setError(`Playwright extension only allows loopback connections (127.0.0.1 or [::1]). Received host: ${host}`);
          return;
        }
      } catch (e) {
        setError(`Invalid mcpRelayUrl parameter in URL: ${relayUrl}. ${e}`);
        return;
      }
      let info = "unknown";
      try {
        const client = JSON.parse(params.get("client") || "{}");
        info = `${client.name || "unknown"}`;
        setClientInfo(info);
        setStatus({
          type: "connecting",
          message: `"${info}" is trying to connect to the Playwright Extension.`
        });
      } catch (e) {
        setStatus({ type: "error", message: "Failed to parse client version." });
        return;
      }
      const parsedVersion = parseInt(params.get("protocolVersion") ?? "", 10);
      const requestedVersion = isNaN(parsedVersion) ? 1 : parsedVersion;
      if (requestedVersion > SUPPORTED_PROTOCOL_VERSION) {
        const extensionVersion = chrome.runtime.getManifest().version;
        setShowTabList(false);
        setStatus({
          type: "error",
          versionMismatch: {
            extensionVersion
          }
        });
        return;
      }
      const response = await chrome.runtime.sendMessage({ type: "connectionRequested", mcpRelayUrl: relayUrl, protocolVersion: requestedVersion });
      if (!response.success) {
        setError(response.error);
        return;
      }
      const expectedToken = getOrCreateAuthToken();
      const token = params.get("token");
      if (token === expectedToken) {
        await handleConnectToTab(void 0, info);
        return;
      }
      if (token) {
        setError("Invalid token provided.");
        return;
      }
      if (params.get("newTab") === "true")
        setShowTabList(false);
      else
        await loadTabs();
    };
    void runAsync();
    const keepalive = setInterval(() => {
      chrome.runtime.sendMessage({ type: "keepalive" }).catch(() => {
      });
    }, 2e4);
    return () => clearInterval(keepalive);
  }, []);
  const loadTabs = reactExports.useCallback(async () => {
    const response = await chrome.runtime.sendMessage({ type: "getTabs" });
    if (response.success)
      setTabs(response.tabs);
    else
      setStatus({ type: "error", message: "Failed to load tabs: " + response.error });
  }, []);
  const handleConnectToTab = reactExports.useCallback(async (tab, clientName = clientInfo) => {
    setShowTabList(false);
    try {
      const response = await chrome.runtime.sendMessage({
        type: "connectToTab",
        tab,
        clientName
      });
      if (response == null ? void 0 : response.success) {
        setStatus({ type: "connected", message: `"${clientName}" connected.` });
      } else {
        setStatus({
          type: "error",
          message: (response == null ? void 0 : response.error) || `"${clientName}" failed to connect.`
        });
      }
    } catch (e) {
      setStatus({
        type: "error",
        message: `"${clientName}" failed to connect: ${e}`
      });
    }
  }, [clientInfo]);
  reactExports.useEffect(() => {
    const listener = (message) => {
      if (message.type === "pendingConnectionClosed") {
        setError("Pending client connection closed.");
        document.title = "Playwright Extension";
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [setError]);
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "app-container", children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "content-wrapper", children: [
    status && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "status-container", children: /* @__PURE__ */ jsxRuntimeExports.jsx(StatusBanner, { status }) }),
    (status == null ? void 0 : status.type) === "connecting" && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "warning-banner", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("strong", { children: "⚠️ Warning:" }),
      " Allowing this connection exposes the entire browser to the client, including any signed-in sessions, cookies, and content in other tabs and windows. Once approved, the client may also be able to reconnect later without showing this dialog again, unless you regenerate the token below and then restart the browser."
    ] }),
    (status == null ? void 0 : status.type) === "connecting" && /* @__PURE__ */ jsxRuntimeExports.jsx(AuthTokenSection, {}),
    showTabList && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "tab-section-title", children: "You can drag tabs into the Playwright group later to make them accessible to the client. Optionally, select a tab to allow and immediately switch to it:" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { children: tabs.map((tab) => /* @__PURE__ */ jsxRuntimeExports.jsx(
        TabItem,
        {
          tab,
          button: /* @__PURE__ */ jsxRuntimeExports.jsx(Button, { variant: "primary", onClick: () => handleConnectToTab(tab), children: "Allow & select" })
        },
        tab.id
      )) })
    ] })
  ] }) });
};
const VersionMismatchError = ({ extensionVersion }) => {
  const readmeUrl = "https://github.com/microsoft/playwright/blob/main/packages/extension/README.md";
  const chromeWebStoreUrl = "https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm";
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
    "Playwright client trying to connect requires newer extension version (current version: ",
    extensionVersion,
    ").",
    " ",
    "Update ",
    /* @__PURE__ */ jsxRuntimeExports.jsx("a", { href: chromeWebStoreUrl, target: "_blank", rel: "noopener noreferrer", children: "Playwright Extension" }),
    " from the Chrome Web Store to the latest version.",
    " ",
    "See ",
    /* @__PURE__ */ jsxRuntimeExports.jsx("a", { href: readmeUrl, target: "_blank", rel: "noopener noreferrer", children: "installation instructions" }),
    " for more details."
  ] });
};
const StatusBanner = ({ status }) => {
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: `status-banner ${status.type}`, children: "versionMismatch" in status ? /* @__PURE__ */ jsxRuntimeExports.jsx(
    VersionMismatchError,
    {
      extensionVersion: status.versionMismatch.extensionVersion
    }
  ) : status.message });
};
const container = document.getElementById("root");
if (container) {
  const root = clientExports.createRoot(container);
  root.render(/* @__PURE__ */ jsxRuntimeExports.jsx(ConnectApp, {}));
}
