// This API runs only in the extension origin. Target pages cannot call it.
function request(op, options = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({type: 'agent-control', op, ...options}, response => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response || !response.ok) return reject(new Error(response?.error || 'SignalTrace control failed'));
      resolve(response);
    });
  });
}

window.SignalTrace = Object.freeze({
  arm: () => request('arm'),
  start: (tabId, origin, settings = {}) => request('start', {tabId, origin, settings}),
  configure: (tabId, settings) => request('configure', {tabId, settings}),
  events: (tabId, afterId = 0, limit = 50) => request('events', {tabId, afterId, limit}),
  stats: tabId => request('stats', {tabId}),
  clear: tabId => request('clear', {tabId}),
  stop: tabId => request('stop', {tabId}),
  tabs: () => new Promise((resolve, reject) => {
    chrome.tabs.query({}, tabs => chrome.runtime.lastError
      ? reject(new Error(chrome.runtime.lastError.message))
      : resolve(tabs.map(tab => ({id: tab.id, url: tab.url || '', title: tab.title || ''}))));
  })
});
