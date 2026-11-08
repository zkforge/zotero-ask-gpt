var chromeHandle;
var ZoteroAIChat;

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  chromeHandle = Cc['@mozilla.org/addons/addon-manager-startup;1']
    .getService(Ci.amIAddonManagerStartup)
    .registerChrome(Services.io.newURI(rootURI + 'manifest.json'), [['content', 'zoteroaichat', rootURI + 'content/']]);
  for (const file of ['rpc.js', 'codex.js', 'sidebar.js', 'addon.js'])
    Services.scriptloader.loadSubScriptWithOptions(rootURI + 'content/' + file, { target: this, ignoreCache: true });
  ZoteroAIChat = new AIChatAddon({ id, version, rootURI });
  // The settings pane runs in the Settings window and reaches the plugin through Zotero.
  Zotero.AIChat = ZoteroAIChat;
  ZoteroAIChat.startup();
}

function onMainWindowLoad({ window }) { ZoteroAIChat?.addWindow(window); }
function onMainWindowUnload({ window }) { ZoteroAIChat?.removeWindow(window); }

function shutdown() {
  ZoteroAIChat?.shutdown();
  ZoteroAIChat = undefined;
  delete Zotero.AIChat;
  chromeHandle?.destruct();
  chromeHandle = undefined;
}
