var tab_listeners = {};
var tab_push = {}, tab_lasturl = {};
var selectedId = -1;
var DEBUGGER_PROTOCOL_VERSION = '1.3';
var debuggerSockets = {};
var debuggerHttp = {};
var attachedDebuggerTabs = {};
var attachingDebuggerTabs = {};
var connectedPorts = [];
var MAX_CAPTURED_BODY_CHARS = 200000;
var ARCHIVE_STORAGE_KEY = 'persistent_archive';
var RESEND_DRAFT_KEY = 'resend_drafts';
var archivePersistTimer = null;
var agentMode = false;
var agentSessions = {};
var agentSequence = 0;
var agentCounters = {};
var agentPort = null;
var agentBroadcastTimer = null;
var settings = {
	log_url: '',
	enable_debugger: true,
	max_events_per_tab: 5000,
	enable_persistent_archive: true,
	enable_postmessage: true,
	enable_client_ws: true,
	enable_server_ws: true,
	enable_http: true,
	enable_http_request_bodies: true,
	enable_http_response_bodies: true,
	filter_null_postmessage: true,
	postmessage_filter: [],
	client_ws_filter: [],
	server_ws_filter: [],
	http_filter: []
};

function debuggerTarget(tabId) {
	return {tabId: tabId};
}

function getMaxEventsPerTab() {
	var parsed = parseInt(settings.max_events_per_tab, 10);
	if(isNaN(parsed)) return 5000;
	if(parsed < 100) return 100;
	if(parsed > 10000) return 10000;
	return parsed;
}

function agentSession(tabId) { return agentSessions[tabId] || null; }

function agentChannel(msg) {
	var api = String(msg.api || '').toLowerCase();
	if(msg.eventType == 'http' || api.indexOf('http') !== -1) return 'http';
	if(api.indexOf('websocket') !== -1) return msg.direction == 'send' ? 'client_ws' : 'server_ws';
	if(api.indexOf('message') !== -1) return 'postmessage';
	return 'other';
}

function agentAllowed(tabId, msg) {
	if(!agentMode) return true;
	var session = agentSession(tabId);
	if(!session) return false;
	var channel = agentChannel(msg);
	if((channel == 'client_ws' || channel == 'server_ws') && session.useDebugger &&
		String(msg.api || '').indexOf('CDP.WebSocket') !== 0) return false;
	try {
		if(msg.parent_url && /^https?:/.test(msg.parent_url) && new URL(msg.parent_url).origin != session.origin) return false;
	} catch(e) { return false; }
	if(channel == 'client_ws' || channel == 'server_ws') {
		var socketUrl = msg.meta && msg.meta.url;
		try {
			if(socketUrl && /^wss?:/.test(socketUrl) &&
				new URL(socketUrl.replace(/^ws/, 'http')).origin != session.origin) return false;
		} catch(e) { return false; }
	}
	if(channel == 'other' || !session.channels[channel]) return false;
	if(channel == 'postmessage' && session.filterNull && (msg.payload === null || msg.payload === 'null')) return false;
	var value = String(msg.payload || '').slice(0, session.maxPayloadChars);
	var filters = session.filters[channel] || [];
	for(var i = 0; i < filters.length; i++) {
		if(value.toLowerCase().indexOf(filters[i]) !== -1 ||
			String(msg.api || '').toLowerCase().indexOf(filters[i]) !== -1 ||
			String(msg.target || '').toLowerCase().indexOf(filters[i]) !== -1) return false;
	}
	return true;
}

function agentPageConfig(tabId) {
	var session = agentSession(tabId);
	return session ? {
		enable_postmessage: !!session.channels.postmessage,
		enable_client_ws: !!session.channels.client_ws && !session.useDebugger,
		enable_server_ws: !!session.channels.server_ws && !session.useDebugger,
		filter_null_postmessage: session.filterNull,
		postmessage_filter: session.filters.postmessage,
		client_ws_filter: session.filters.client_ws,
		server_ws_filter: session.filters.server_ws,
		agent_quiet: true,
		agent_max_payload_chars: session.maxPayloadChars
	} : {enable_postmessage: false, enable_client_ws: false, enable_server_ws: false, agent_quiet: true};
}

function normalizeAgentSession(input, previous) {
	input = input || {};
	previous = previous || {};
	var channels = Object.assign({postmessage: true, client_ws: true, server_ws: true, http: false}, previous.channels || {}, input.channels || {});
	for(var channel in channels) channels[channel] = !!channels[channel];
	channels.http = false;
	var filters = {};
	for(var key of ['postmessage', 'client_ws', 'server_ws']) {
		var raw = (input.filters && input.filters[key]) || (previous.filters && previous.filters[key]) || [];
		if(!Array.isArray(raw) || raw.length > 30 || raw.some(function(x) { return typeof x != 'string' || x.length > 120; })) throw new Error('Invalid filter list');
		filters[key] = raw.map(function(x) { return x.toLowerCase(); }).filter(Boolean);
	}
	var maxEvents = Number(input.maxEvents === undefined ? (previous.maxEvents || 300) : input.maxEvents);
	var maxPayloadChars = Number(input.maxPayloadChars === undefined ? (previous.maxPayloadChars || 2048) : input.maxPayloadChars);
	if(!Number.isInteger(maxEvents) || maxEvents < 20 || maxEvents > 1000) throw new Error('maxEvents must be 20..1000');
	if(!Number.isInteger(maxPayloadChars) || maxPayloadChars < 128 || maxPayloadChars > 8192) throw new Error('maxPayloadChars must be 128..8192');
	return {channels: channels, filters: filters, maxEvents: maxEvents, maxPayloadChars: maxPayloadChars,
		filterNull: input.filterNull === undefined ? previous.filterNull !== false : !!input.filterNull,
		useDebugger: input.useDebugger === undefined ? previous.useDebugger !== false : !!input.useDebugger};
}

function normalizeFilterList(value) {
	if(Array.isArray(value)) {
		return value.filter(function(item) {
			return typeof item == 'string' && item.trim().length > 0;
		});
	}
	if(typeof value == 'string' && value.trim().length > 0) {
		return [value.trim()];
	}
	return [];
}

function matchesRegexFilter(pattern, value) {
	if(!pattern) return false;
	var normalizedPattern = String(pattern).toLowerCase();
	var normalizedValue = String(value || '').toLowerCase();
	if(normalizedValue.indexOf(normalizedPattern) !== -1) {
		return true;
	}
	try {
		return new RegExp(pattern, 'i').test(value || '');
	} catch (e) {
		return false;
	}
}

function matchesAnyFilter(patterns, value) {
	var normalizedPatterns = normalizeFilterList(patterns);
	for(var i = 0; i < normalizedPatterns.length; i++) {
		if(matchesRegexFilter(normalizedPatterns[i], value)) {
			return true;
		}
	}
	return false;
}

function stringifyPayload(payload) {
	if(typeof payload == 'string') return payload;
	if(typeof payload == 'undefined' || payload === null) return '';
	try {
		return JSON.stringify(payload);
	} catch (e) {
		try {
			return String(payload);
		} catch (e2) {
			return '';
		}
	}
}

function shouldCaptureChannel(channel, payload, api, target) {
	if(agentMode) return true; // Agent filters run once in recordEvent, per tab.
	var haystack = [stringifyPayload(payload), api || '', target || ''].join('\n');
	if(channel == 'postmessage') {
		if(settings.filter_null_postmessage && (payload === null || typeof payload == 'undefined' || stringifyPayload(payload) == 'null')) {
			return false;
		}
		return settings.enable_postmessage && !matchesAnyFilter(settings.postmessage_filter, haystack);
	}
	if(channel == 'client_ws') {
		return settings.enable_client_ws && !matchesAnyFilter(settings.client_ws_filter, haystack);
	}
	if(channel == 'server_ws') {
		return settings.enable_server_ws && !matchesAnyFilter(settings.server_ws_filter, haystack);
	}
	if(channel == 'http') {
		return settings.enable_http && !matchesAnyFilter(settings.http_filter, haystack);
	}
	return true;
}

function isTrackableTab(tab) {
	if(!tab || !tab.id || !tab.url) return false;
	return tab.url.indexOf('http://') === 0 || tab.url.indexOf('https://') === 0;
}

function getEventFingerprint(msg) {
	if(msg.eventType == 'listener') {
		return [
			msg.eventType,
			msg.api || '',
			msg.target || '',
			msg.domain || '',
			msg.window || '',
			msg.hops || '',
			msg.stack || '',
			msg.listener || ''
		].join('::');
	}
	return null;
}

function getBadgeCount(tabId) {
	return tab_listeners[tabId] ? tab_listeners[tabId].length : 0;
}

function refreshCount(tabId) {
	var effectiveTabId = typeof tabId == 'number' ? tabId : selectedId;
	if(typeof effectiveTabId != 'number' || effectiveTabId < 0) return;
	var txt = getBadgeCount(effectiveTabId);
	chrome.tabs.get(effectiveTabId, function() {
		if(!chrome.runtime.lastError) {
			chrome.action.setBadgeText({"text": txt ? '' + txt : '', tabId: effectiveTabId});
			if(txt > 0) {
				chrome.action.setBadgeBackgroundColor({color: [255, 0, 0, 255]});
			} else {
				chrome.action.setBadgeBackgroundColor({color: [0, 0, 255, 0]});
			}
		}
	});
}

function broadcastState() {
	if(agentMode && !connectedPorts.length) return;
	if(agentMode && !agentBroadcastTimer) {
		agentBroadcastTimer = setTimeout(function() { agentBroadcastTimer = null; broadcastStateNow(); }, 1000);
		return;
	}
	broadcastStateNow();
}

function broadcastStateNow() {
	var payload = {listeners: tab_listeners, settings: settings, selectedId: selectedId};
	for(var i = connectedPorts.length - 1; i >= 0; i--) {
		try {
			connectedPorts[i].postMessage(payload);
		} catch (e) {
		}
	}
}

function persistArchiveNow() {
	archivePersistTimer = null;
	chrome.storage.local.set((function() {
		var payload = {};
		payload[ARCHIVE_STORAGE_KEY] = tab_listeners;
		return payload;
	})());
}

function scheduleArchivePersist() {
	if(agentMode) return;
	if(!settings.enable_persistent_archive) return;
	if(archivePersistTimer) clearTimeout(archivePersistTimer);
	archivePersistTimer = setTimeout(persistArchiveNow, 750);
}

function clearPersistentArchive(callback) {
	chrome.storage.local.remove([ARCHIVE_STORAGE_KEY], function() {
		if(callback) callback();
	});
}

function clearAllCapturedData(callback) {
	tab_listeners = {};
	chrome.tabs.query({}, function(tabs) {
		for(var i = 0; i < tabs.length; i++) {
			refreshCount(tabs[i].id);
		}
		clearPersistentArchive(function() {
			broadcastState();
			if(callback) callback();
		});
	});
}

function loadPersistentArchive(callback) {
	chrome.storage.local.get(ARCHIVE_STORAGE_KEY, function(items) {
		var stored = items[ARCHIVE_STORAGE_KEY];
		if(stored && typeof stored == 'object') {
			tab_listeners = stored;
		}
		if(callback) callback();
	});
}

function storeResendDraft(draft, callback) {
	chrome.storage.local.get(RESEND_DRAFT_KEY, function(items) {
		var drafts = items[RESEND_DRAFT_KEY] || {};
		var draftId = 'draft_' + Date.now() + '_' + Math.random().toString(16).slice(2);
		drafts[draftId] = draft;
		var payload = {};
		payload[RESEND_DRAFT_KEY] = drafts;
		chrome.storage.local.set(payload, function() {
			if(callback) callback(draftId);
		});
	});
}

function getResendDraft(draftId, callback) {
	chrome.storage.local.get(RESEND_DRAFT_KEY, function(items) {
		var drafts = items[RESEND_DRAFT_KEY] || {};
		callback(draftId ? (drafts[draftId] || null) : null);
	});
}

function openResendPage(draft) {
	storeResendDraft(draft, function(draftId) {
		chrome.tabs.create({url: chrome.runtime.getURL('resend.html?draft=' + encodeURIComponent(draftId))});
	});
}

function parseReplayPayload(raw) {
	if(typeof raw != 'string') return raw;
	try {
		return JSON.parse(raw);
	} catch (e) {
		return raw;
	}
}

function replayPostMessage(draft, callback) {
	chrome.scripting.executeScript({
		target: {tabId: draft.tabId},
		world: 'MAIN',
		func: function(payloadText, targetOrigin) {
			var payload;
			try {
				payload = JSON.parse(payloadText);
			} catch (e) {
				payload = payloadText;
			}
			window.postMessage(payload, targetOrigin || '*');
			return {ok: true};
		},
		args: [draft.payload || '', draft.targetOrigin || '*']
	}, function(results) {
		if(chrome.runtime.lastError) {
			callback({ok: false, error: chrome.runtime.lastError.message});
			return;
		}
		callback(results && results[0] ? results[0].result : {ok: true});
	});
}

function replayWebSocket(draft, callback) {
	chrome.scripting.executeScript({
		target: {tabId: draft.tabId},
		world: 'MAIN',
		func: function(url, payloadText) {
			return new Promise(function(resolve) {
				var resolved = false;
				function finish(result) {
					if(resolved) return;
					resolved = true;
					resolve(result);
				}
				try {
					var ws = new WebSocket(url);
					var timeout = setTimeout(function() {
						try { ws.close(); } catch (e) {}
						finish({ok: false, error: 'Timed out opening WebSocket'});
					}, 5000);
					ws.addEventListener('open', function() {
						try {
							var payload;
							try {
								payload = JSON.parse(payloadText);
							} catch (e) {
								payload = payloadText;
							}
							ws.send(typeof payload == 'string' ? payload : JSON.stringify(payload));
							clearTimeout(timeout);
							setTimeout(function() {
								try { ws.close(); } catch (e) {}
								finish({ok: true});
							}, 300);
						} catch (error) {
							clearTimeout(timeout);
							finish({ok: false, error: error.message});
						}
					});
					ws.addEventListener('error', function() {
						clearTimeout(timeout);
						finish({ok: false, error: 'WebSocket error'});
					});
				} catch (error) {
					finish({ok: false, error: error.message});
				}
			});
		},
		args: [draft.url || '', draft.payload || '']
	}, function(results) {
		if(chrome.runtime.lastError) {
			callback({ok: false, error: chrome.runtime.lastError.message});
			return;
		}
		callback(results && results[0] ? results[0].result : {ok: true});
	});
}

function replayHttp(draft, callback) {
	chrome.scripting.executeScript({
		target: {tabId: draft.tabId},
		world: 'MAIN',
		func: function(url, method, headers, bodyText) {
			return fetch(url, {
				method: method,
				headers: headers || {},
				body: bodyText.length ? bodyText : undefined,
				credentials: 'include'
			}).then(function(response) {
				return response.text().then(function(text) {
					return {
						ok: true,
						status: response.status,
						statusText: response.statusText,
						bodyPreview: text.slice(0, 2000)
					};
				});
			}).catch(function(error) {
				return {ok: false, error: error.message};
			});
		},
		args: [draft.url || '', draft.method || 'GET', draft.headers || {}, draft.body || '']
	}, function(results) {
		if(chrome.runtime.lastError) {
			callback({ok: false, error: chrome.runtime.lastError.message});
			return;
		}
		callback(results && results[0] ? results[0].result : {ok: true});
	});
}

function replayDraft(draft, callback) {
	if(!draft || !draft.tabId) {
		callback({ok: false, error: 'Missing resend draft'});
		return;
	}
	if(draft.kind == 'postmessage') {
		replayPostMessage(draft, callback);
		return;
	}
	if(draft.kind == 'websocket') {
		replayWebSocket(draft, callback);
		return;
	}
	if(draft.kind == 'http') {
		replayHttp(draft, callback);
		return;
	}
	callback({ok: false, error: 'Unsupported draft kind'});
}

function storeEvent(tabId, msg) {
	if(!tab_listeners[tabId]) tab_listeners[tabId] = [];
	var fingerprint = getEventFingerprint(msg);
	if(fingerprint) {
		for(var i = 0; i < tab_listeners[tabId].length; i++) {
			if(tab_listeners[tabId][i].fingerprint == fingerprint) {
				return false;
			}
		}
		msg.fingerprint = fingerprint;
	}
	tab_listeners[tabId][tab_listeners[tabId].length] = msg;
	var maxEvents = agentMode && agentSession(tabId) ? agentSession(tabId).maxEvents : getMaxEventsPerTab();
	if(tab_listeners[tabId].length > maxEvents) {
		var excess = tab_listeners[tabId].length - maxEvents;
		tab_listeners[tabId].splice(0, excess);
		if(agentMode && agentCounters[tabId]) agentCounters[tabId].evicted = (agentCounters[tabId].evicted || 0) + excess;
	}
	return true;
}

function logListener(data) {
	if(!settings.log_url.length) return;
	data = JSON.stringify(data);
	try {
		fetch(settings.log_url, {
			method: 'post',
			headers: {
				"Content-type": "application/json; charset=UTF-8"
			},
			body: data
		});
	} catch(e) {
	}
}

function recordEvent(tabId, msg) {
	if(!agentAllowed(tabId, msg)) {
		if(agentMode && agentSession(tabId)) {
			if(!agentCounters[tabId]) agentCounters[tabId] = {seen: 0, filtered: 0, dropped: 0, evicted: 0};
			agentCounters[tabId].seen++;
			agentCounters[tabId].filtered++;
		}
		return;
	}
	if(agentMode) {
		var session = agentSession(tabId);
		if(!agentCounters[tabId]) agentCounters[tabId] = {seen: 0, filtered: 0, dropped: 0, evicted: 0};
		agentCounters[tabId].seen++;
		msg.payload = String(msg.payload || '').slice(0, session.maxPayloadChars);
		delete msg.fullstack;
		delete msg.stack;
		delete msg.listener;
		if(msg.meta) msg.meta = {url: msg.meta.url ? String(msg.meta.url).split('?')[0] : undefined,
			targetOrigin: msg.meta.targetOrigin, opcode: msg.meta.opcode};
		msg.id = ++agentSequence;
	}
	if(!msg.captured_at) msg.captured_at = Date.now();
	var stored = storeEvent(tabId, msg);
	if(stored) {
		if(!agentMode) logListener(msg);
		if(!agentMode) refreshCount(tabId);
		scheduleArchivePersist();
		broadcastState();
	} else if(agentMode) {
		agentCounters[tabId].dropped++;
	}
}

function sendConsoleEvent(tabId, event) {
	if(agentMode) return;
	try {
		chrome.tabs.sendMessage(tabId, {
			type: 'postMessageTrackerConsoleEvent',
			event: event
		});
	} catch (e) {
	}
}

function ensureDebuggerState(tabId) {
	if(!debuggerSockets[tabId]) debuggerSockets[tabId] = {};
	return debuggerSockets[tabId];
}

function ensureHttpState(tabId) {
	if(!debuggerHttp[tabId]) debuggerHttp[tabId] = {};
	return debuggerHttp[tabId];
}

function clearDebuggerState(tabId) {
	delete debuggerSockets[tabId];
	delete debuggerHttp[tabId];
}

function describeDebuggerSocket(tabId, requestId) {
	var state = ensureDebuggerState(tabId);
	var socket = state[requestId] || {};
	var label = 'CDP.WebSocket(' + requestId + ')';
	if(socket.url) label += ' ' + socket.url;
	return {
		target: label,
		url: socket.url || null
	};
}

function makeDebuggerTrafficEvent(tabId, api, direction, requestId, payload, meta) {
	var socket = describeDebuggerSocket(tabId, requestId);
	return {
		parent_url: '',
		window: 'cdp',
		hops: 'cdp',
		domain: '',
		captured_at: Date.now(),
		eventType: 'traffic',
		api: api,
		direction: direction,
		target: socket.target,
		stack: 'chrome.debugger',
		fullstack: ['chrome.debugger', api],
		listener: direction + ' ' + api + ' ' + socket.target,
		payload: payload,
		meta: Object.assign({requestId: requestId, url: socket.url}, meta || {})
	};
}

function truncateBody(value) {
	if(typeof value != 'string') return value;
	if(value.length <= MAX_CAPTURED_BODY_CHARS) return value;
	return value.slice(0, MAX_CAPTURED_BODY_CHARS) + '\n[truncated]';
}

function buildHttpHaystack(record) {
	return [
		record.request ? record.request.method : '',
		record.request ? record.request.url : '',
		stringifyPayload(record.request ? record.request.headers : ''),
		stringifyPayload(record.requestBody || ''),
		stringifyPayload(record.response ? record.response.headers : ''),
		stringifyPayload(record.responseBody || ''),
		record.errorText || ''
	].join('\n');
}

function makeHttpEvent(tabId, requestId, record) {
	var request = record.request || {};
	var response = record.response || {};
	var requestLine = (request.method || 'GET') + ' ' + (request.url || '');
	var statusLine = response.status ? 'HTTP ' + response.status + ' ' + (response.statusText || '') : (record.errorText || '[pending]');
	var payloadParts = [requestLine, statusLine];
	if(record.requestBody) payloadParts.push('Request body:\n' + record.requestBody);
	if(record.responseBody) payloadParts.push('Response body:\n' + record.responseBody);
	return {
		parent_url: record.documentURL || '',
		window: 'cdp',
		hops: 'cdp',
		domain: '',
		captured_at: Date.now(),
		eventType: 'http',
		api: 'CDP.HTTP',
		direction: 'roundtrip',
		target: request.url || '',
		stack: 'chrome.debugger',
		fullstack: ['chrome.debugger', 'CDP.HTTP'],
		listener: requestLine + '\n' + statusLine,
		payload: payloadParts.join('\n\n'),
		meta: {
			requestId: requestId,
			method: request.method || 'GET',
			url: request.url || '',
			resourceType: record.type || '',
			status: response.status || null,
			statusText: response.statusText || '',
			requestHeaders: request.headers || {},
			requestHeadersExtra: record.requestExtraHeaders || {},
			responseHeaders: response.headers || {},
			responseHeadersExtra: record.responseExtraHeaders || {},
			requestBody: record.requestBody || '',
			responseBody: record.responseBody || '',
			mimeType: response.mimeType || '',
			remoteIPAddress: response.remoteIPAddress || '',
			fromDiskCache: !!response.fromDiskCache,
			fromServiceWorker: !!response.fromServiceWorker,
			encodedDataLength: record.encodedDataLength || 0,
			base64EncodedResponseBody: !!record.responseBodyBase64Encoded,
			requestBodyTruncated: !!record.requestBodyTruncated,
			responseBodyTruncated: !!record.responseBodyTruncated,
			failed: !!record.failed,
			errorText: record.errorText || '',
			redirected: !!record.redirected
		}
	};
}

function finalizeHttpRecord(tabId, requestId) {
	var state = ensureHttpState(tabId);
	var record = state[requestId];
	if(!record || record.finalized) return;
	record.finalized = true;
	var event = makeHttpEvent(tabId, requestId, record);
	if(shouldCaptureChannel('http', buildHttpHaystack(record), event.api, event.target)) {
		recordEvent(tabId, event);
		sendConsoleEvent(tabId, event);
	}
	delete state[requestId];
}

function getDebuggerBody(tabId, method, params, callback) {
	chrome.debugger.sendCommand(debuggerTarget(tabId), method, params, function(result) {
		if(chrome.runtime.lastError) {
			callback(null, chrome.runtime.lastError.message);
			return;
		}
		callback(result || {}, null);
	});
}

function maybeFetchRequestBody(tabId, requestId) {
	if(!settings.enable_http_request_bodies) return;
	var state = ensureHttpState(tabId);
	var record = state[requestId];
	if(!record || !record.request || !record.request.hasPostData) return;
	getDebuggerBody(tabId, 'Network.getRequestPostData', {requestId: requestId}, function(result) {
		var latest = ensureHttpState(tabId)[requestId];
		if(!latest || latest.finalized) return;
		if(result && typeof result.postData == 'string') {
			latest.requestBodyTruncated = result.postData.length > MAX_CAPTURED_BODY_CHARS;
			latest.requestBody = truncateBody(result.postData);
		}
	});
}

function maybeFetchResponseBody(tabId, requestId, done) {
	if(!settings.enable_http_response_bodies) {
		done();
		return;
	}
	getDebuggerBody(tabId, 'Network.getResponseBody', {requestId: requestId}, function(result) {
		var latest = ensureHttpState(tabId)[requestId];
		if(!latest || latest.finalized) {
			done();
			return;
		}
		if(result && typeof result.body == 'string') {
			latest.responseBodyBase64Encoded = !!result.base64Encoded;
			latest.responseBodyTruncated = result.body.length > MAX_CAPTURED_BODY_CHARS;
			latest.responseBody = truncateBody(result.body);
		}
		done();
	});
}

function handleHttpNetworkEvent(source, method, params) {
	if(!source.tabId || agentMode || !settings.enable_http) return;
	var tabId = source.tabId;
	var state = ensureHttpState(tabId);
	var record;
	if(method == 'Network.requestWillBeSent') {
		if(params.redirectResponse && state[params.requestId]) {
			record = state[params.requestId];
			record.response = params.redirectResponse;
			record.redirected = true;
			finalizeHttpRecord(tabId, params.requestId);
		}
		record = state[params.requestId] || {};
		record.request = params.request || {};
		record.documentURL = params.documentURL || '';
		record.initiator = params.initiator || null;
		record.type = params.type || '';
		record.wallTime = params.wallTime || null;
		record.timestamp = params.timestamp || null;
		state[params.requestId] = record;
		if(record.request && typeof record.request.postData == 'string') {
			record.requestBodyTruncated = record.request.postData.length > MAX_CAPTURED_BODY_CHARS;
			record.requestBody = truncateBody(record.request.postData);
		}
		maybeFetchRequestBody(tabId, params.requestId);
		return;
	}
	if(method == 'Network.requestWillBeSentExtraInfo') {
		record = state[params.requestId] || {};
		record.requestExtraHeaders = params.headers || {};
		state[params.requestId] = record;
		return;
	}
	if(method == 'Network.responseReceived') {
		record = state[params.requestId] || {};
		record.response = params.response || {};
		record.type = record.type || params.type || '';
		state[params.requestId] = record;
		return;
	}
	if(method == 'Network.responseReceivedExtraInfo') {
		record = state[params.requestId] || {};
		record.responseExtraHeaders = params.headers || {};
		record.responseStatusCode = params.statusCode || null;
		state[params.requestId] = record;
		return;
	}
	if(method == 'Network.loadingFinished') {
		record = state[params.requestId] || {};
		record.encodedDataLength = params.encodedDataLength || 0;
		state[params.requestId] = record;
		maybeFetchResponseBody(tabId, params.requestId, function() {
			finalizeHttpRecord(tabId, params.requestId);
		});
		return;
	}
	if(method == 'Network.loadingFailed') {
		record = state[params.requestId] || {};
		record.failed = true;
		record.errorText = params.errorText || '';
		record.canceled = !!params.canceled;
		record.blockedReason = params.blockedReason || '';
		state[params.requestId] = record;
		finalizeHttpRecord(tabId, params.requestId);
	}
}

function handleDebuggerNetworkEvent(source, method, params) {
	if(!source.tabId) return;
	if(agentMode && (!agentSession(source.tabId) || !agentSession(source.tabId).useDebugger)) return;
	var tabId = source.tabId;
	var state = ensureDebuggerState(tabId);
	var event;
	if(method == 'Network.webSocketCreated') {
		state[params.requestId] = {url: params.url, initiator: params.initiator || null};
		event = makeDebuggerTrafficEvent(tabId, 'CDP.WebSocket.created', 'send', params.requestId, '[connect]', {
			initiator: params.initiator || null
		});
		if(shouldCaptureChannel('client_ws', event.payload, event.api, event.target)) {
			recordEvent(tabId, event);
			sendConsoleEvent(tabId, event);
		}
		return;
	}
	if(method == 'Network.webSocketWillSendHandshakeRequest') {
		if(!state[params.requestId]) state[params.requestId] = {};
		state[params.requestId].url = params.request && params.request.url ? params.request.url : state[params.requestId].url;
		event = makeDebuggerTrafficEvent(tabId, 'CDP.WebSocket.handshakeRequest', 'send', params.requestId, '[handshake-request]', {
			headers: params.request ? params.request.headers : null
		});
		if(shouldCaptureChannel('client_ws', event.payload, event.api, event.target)) {
			recordEvent(tabId, event);
			sendConsoleEvent(tabId, event);
		}
		return;
	}
	if(method == 'Network.webSocketHandshakeResponseReceived') {
		event = makeDebuggerTrafficEvent(tabId, 'CDP.WebSocket.handshakeResponse', 'receive', params.requestId, '[handshake-response]', {
			status: params.response ? params.response.status : null,
			statusText: params.response ? params.response.statusText : null,
			headers: params.response ? params.response.headers : null
		});
		if(shouldCaptureChannel('server_ws', event.payload, event.api, event.target)) {
			recordEvent(tabId, event);
			sendConsoleEvent(tabId, event);
		}
		return;
	}
	if(method == 'Network.webSocketFrameSent') {
		event = makeDebuggerTrafficEvent(tabId, 'CDP.WebSocket.frameSent', 'send', params.requestId, params.response ? params.response.payloadData : '', {
			opcode: params.response ? params.response.opcode : null,
			mask: params.response ? params.response.mask : null
		});
		if(shouldCaptureChannel('client_ws', event.payload, event.api, event.target)) {
			recordEvent(tabId, event);
			sendConsoleEvent(tabId, event);
		}
		return;
	}
	if(method == 'Network.webSocketFrameReceived') {
		event = makeDebuggerTrafficEvent(tabId, 'CDP.WebSocket.frameReceived', 'receive', params.requestId, params.response ? params.response.payloadData : '', {
			opcode: params.response ? params.response.opcode : null,
			mask: params.response ? params.response.mask : null
		});
		if(shouldCaptureChannel('server_ws', event.payload, event.api, event.target)) {
			recordEvent(tabId, event);
			sendConsoleEvent(tabId, event);
		}
		return;
	}
	if(method == 'Network.webSocketFrameError') {
		event = makeDebuggerTrafficEvent(tabId, 'CDP.WebSocket.frameError', 'receive', params.requestId, '[frame-error]', {
			errorMessage: params.errorMessage || null
		});
		if(shouldCaptureChannel('server_ws', event.payload, event.api, event.target)) {
			recordEvent(tabId, event);
			sendConsoleEvent(tabId, event);
		}
		return;
	}
	if(method == 'Network.webSocketClosed') {
		event = makeDebuggerTrafficEvent(tabId, 'CDP.WebSocket.closed', 'receive', params.requestId, '[closed]', null);
		if(shouldCaptureChannel('server_ws', event.payload, event.api, event.target)) {
			recordEvent(tabId, event);
			sendConsoleEvent(tabId, event);
		}
		delete state[params.requestId];
	}
}

function attachDebuggerToTab(tab, ready) {
	ready = ready || function() {};
	if(agentMode) {
		var session = tab && agentSession(tab.id);
		if(!session || !session.useDebugger || (!session.channels.client_ws && !session.channels.server_ws)) { ready(null); return; }
	} else if(!settings.enable_debugger || (!settings.enable_client_ws && !settings.enable_server_ws && !settings.enable_http)) { ready(null); return; }
	if(!isTrackableTab(tab) && !(agentMode && tab && tab.url == 'about:blank')) { ready(new Error('Tab cannot be debugged')); return; }
	if(agentMode && tab.url != 'about:blank' && new URL(tab.url).origin != agentSession(tab.id).origin) { ready(new Error('Tab outside session origin')); return; }
	if(attachedDebuggerTabs[tab.id]) { ready(null); return; }
	if(attachingDebuggerTabs[tab.id]) { attachingDebuggerTabs[tab.id].push(ready); return; }
	attachingDebuggerTabs[tab.id] = [ready];
	function finish(error) {
		var callbacks = attachingDebuggerTabs[tab.id] || [];
		delete attachingDebuggerTabs[tab.id];
		callbacks.forEach(function(callback) { callback(error || null); });
	}
	chrome.debugger.attach(debuggerTarget(tab.id), DEBUGGER_PROTOCOL_VERSION, function() {
		if(chrome.runtime.lastError) {
			console.log('debugger attach failed', tab.id, chrome.runtime.lastError.message);
			finish(new Error(chrome.runtime.lastError.message));
			return;
		}
		attachedDebuggerTabs[tab.id] = true;
		if(agentMode && (!agentSession(tab.id) || !agentSession(tab.id).useDebugger)) {
			detachDebuggerFromTab(tab.id);
			finish(new Error('Agent session is no longer active'));
			return;
		}
		ensureDebuggerState(tab.id);
		ensureHttpState(tab.id);
		chrome.debugger.sendCommand(debuggerTarget(tab.id), 'Network.enable', {maxPostDataSize: MAX_CAPTURED_BODY_CHARS}, function() {
			if(chrome.runtime.lastError) {
				console.log('debugger network enable failed', tab.id, chrome.runtime.lastError.message);
				finish(new Error(chrome.runtime.lastError.message));
				return;
			}
			finish(null);
		});
		broadcastState();
	});
}

function detachDebuggerFromTab(tabId) {
	if(!attachedDebuggerTabs[tabId]) {
		clearDebuggerState(tabId);
		return;
	}
	chrome.debugger.detach(debuggerTarget(tabId), function() {
		if(chrome.runtime.lastError) {
			console.log('debugger detach failed', tabId, chrome.runtime.lastError.message);
		}
	});
	delete attachedDebuggerTabs[tabId];
	clearDebuggerState(tabId);
	broadcastState();
}

function syncDebuggers() {
	if(agentMode) {
		for(var currentId in attachedDebuggerTabs) if(!agentSession(Number(currentId))) detachDebuggerFromTab(Number(currentId));
		chrome.tabs.query({}, function(tabs) { tabs.forEach(attachDebuggerToTab); });
		return;
	}
	if(!settings.enable_debugger || (!settings.enable_client_ws && !settings.enable_server_ws && !settings.enable_http)) {
		for(var tabId in attachedDebuggerTabs) {
			detachDebuggerFromTab(parseInt(tabId, 10));
		}
		return;
	}
	chrome.tabs.query({}, function(tabs) {
		for(var i = 0; i < tabs.length; i++) {
			attachDebuggerToTab(tabs[i]);
		}
	});
}

function normalizeSettings(items) {
	settings.log_url = items.log_url || '';
	settings.enable_debugger = items.enable_debugger !== false;
	settings.max_events_per_tab = items.max_events_per_tab || 5000;
	settings.enable_persistent_archive = items.enable_persistent_archive !== false;
	settings.enable_postmessage = items.enable_postmessage !== false;
	settings.enable_client_ws = items.enable_client_ws !== false;
	settings.enable_server_ws = items.enable_server_ws !== false;
	settings.enable_http = items.enable_http !== false;
	settings.enable_http_request_bodies = items.enable_http_request_bodies !== false;
	settings.enable_http_response_bodies = items.enable_http_response_bodies !== false;
	settings.filter_null_postmessage = items.filter_null_postmessage !== false;
	settings.postmessage_filter = normalizeFilterList(items.postmessage_filter);
	settings.client_ws_filter = normalizeFilterList(items.client_ws_filter);
	settings.server_ws_filter = normalizeFilterList(items.server_ws_filter);
	settings.http_filter = normalizeFilterList(items.http_filter);
}

function loadSettings(callback) {
	chrome.storage.sync.get({
		log_url: '',
		enable_debugger: true,
		max_events_per_tab: 5000,
		enable_persistent_archive: true,
			enable_postmessage: true,
			enable_client_ws: true,
			enable_server_ws: true,
			enable_http: true,
			enable_http_request_bodies: true,
			enable_http_response_bodies: true,
			filter_null_postmessage: true,
			postmessage_filter: [],
			client_ws_filter: [],
			server_ws_filter: [],
			http_filter: []
		}, function(items) {
		normalizeSettings(items);
		if(callback) callback();
	});
}

function updateSettings(nextSettings, callback) {
	chrome.storage.sync.set(nextSettings, function() {
		loadSettings(function() {
			if(settings.enable_persistent_archive) {
				scheduleArchivePersist();
			}
			syncDebuggers();
			broadcastState();
			if(callback) callback();
		});
	});
}

function stopCapturing(callback) {
	updateSettings({
		enable_debugger: false,
		enable_postmessage: false,
		enable_client_ws: false,
		enable_server_ws: false,
		enable_http: false,
		enable_http_request_bodies: false,
		enable_http_response_bodies: false
	}, callback);
}

function startCapturing(callback) {
	updateSettings({
		enable_debugger: true,
		enable_postmessage: true,
		enable_client_ws: true,
		enable_server_ws: true,
		enable_http: true,
		enable_http_request_bodies: true,
		enable_http_response_bodies: true
	}, callback);
}

function getStatePayload() {
	return {listeners: tab_listeners, settings: settings, selectedId: selectedId};
}

function buildResendDraft(payload) {
	var event = payload.event || {};
	var api = (event.api || '').toLowerCase();
	if(event.eventType == 'http' || api.indexOf('http') !== -1) {
		return {
			kind: 'http',
			tabId: payload.tabId,
			method: event.meta && event.meta.method ? event.meta.method : 'GET',
			url: event.meta && event.meta.url ? event.meta.url : event.target || '',
			headers: event.meta && event.meta.requestHeaders ? event.meta.requestHeaders : {},
			body: event.meta && event.meta.requestBody ? event.meta.requestBody : '',
			original: event
		};
	}
	if(api.indexOf('websocket') !== -1) {
		return {
			kind: 'websocket',
			tabId: payload.tabId,
			url: event.meta && event.meta.url ? event.meta.url : event.target || '',
			payload: event.payload || '',
			original: event
		};
	}
	return {
		kind: 'postmessage',
		tabId: payload.tabId,
		targetOrigin: event.meta && event.meta.targetOrigin ? event.meta.targetOrigin : '*',
		payload: event.payload || '',
		original: event
	};
}

function agentResult(tabId, afterId, limit) {
	var events = tab_listeners[tabId] || [];
	var selected = events.filter(function(event) { return event.id > afterId; }).slice(0, limit);
	return {events: selected, nextId: selected.length ? selected[selected.length - 1].id : afterId,
		oldestId: events.length ? events[0].id : null, retained: events.length,
		counters: agentCounters[tabId] || {seen: 0, filtered: 0, dropped: 0, evicted: 0}};
}

function handleAgentControl(msg, reply) {
	var op = msg.op;
	if(op == 'arm') {
		agentMode = true;
		agentSessions = {};
		agentCounters = {};
		tab_listeners = {};
		if(archivePersistTimer) clearTimeout(archivePersistTimer);
		archivePersistTimer = null;
		clearPersistentArchive();
		syncDebuggers();
		chrome.storage.session.set({agentMode: true, agentSessions: {}}, function() { reply({ok: true}); });
		return;
	}
	if(!agentMode) { reply({ok: false, error: 'Call arm first'}); return; }
	var tabId = Number(msg.tabId);
	if(!Number.isInteger(tabId) || tabId < 1) { reply({ok: false, error: 'Valid tabId required'}); return; }
	chrome.tabs.get(tabId, function(tab) {
		if(chrome.runtime.lastError || !tab) { reply({ok: false, error: 'Tab not found'}); return; }
		try {
			if(op == 'start' || op == 'configure') {
				if(op == 'configure' && !agentSession(tabId)) throw new Error('No active session');
				var session = normalizeAgentSession(msg.settings, agentSession(tabId));
				if(op == 'start') {
					var origin = new URL(msg.origin).origin;
					if(!/^https?:/.test(origin)) throw new Error('HTTP(S) origin required');
					if(tab.url && /^https?:/.test(tab.url) && new URL(tab.url).origin != origin) throw new Error('Tab origin differs');
					session.origin = origin;
					tab_listeners[tabId] = [];
					agentCounters[tabId] = {seen: 0, filtered: 0, dropped: 0, evicted: 0};
				} else session.origin = agentSession(tabId).origin;
				agentSessions[tabId] = session;
				chrome.storage.session.set({agentMode: true, agentSessions: agentSessions}, function() {
					chrome.tabs.sendMessage(tabId, {type: 'agent-config', settings: agentPageConfig(tabId)}, function() {
						void chrome.runtime.lastError;
						if(!session.useDebugger) {
							detachDebuggerFromTab(tabId);
							reply({ok: true, tabId: tabId, settings: session});
						} else attachDebuggerToTab(tab, function(error) {
							if(error) {
								session.useDebugger = false;
								detachDebuggerFromTab(tabId);
								chrome.storage.session.set({agentMode: true, agentSessions: agentSessions});
								chrome.tabs.sendMessage(tabId, {type: 'agent-config', settings: agentPageConfig(tabId)}, function() { void chrome.runtime.lastError; });
							}
							reply({ok: true, tabId: tabId, settings: session,
								debuggerError: error ? error.message : null});
						});
					});
				});
			} else if(op == 'events') {
				if(!agentSession(tabId)) throw new Error('No active session');
				var afterId = Math.max(0, Number(msg.afterId) || 0);
				var limit = Math.min(100, Math.max(1, Number(msg.limit) || 50));
				reply(Object.assign({ok: true}, agentResult(tabId, afterId, limit)));
			} else if(op == 'stats') {
				reply({ok: true, tabId: tabId, retained: (tab_listeners[tabId] || []).length,
					counters: agentCounters[tabId] || {seen: 0, filtered: 0, dropped: 0, evicted: 0},
					settings: agentSession(tabId)});
			} else if(op == 'clear') {
				tab_listeners[tabId] = [];
				agentCounters[tabId] = {seen: 0, filtered: 0, dropped: 0, evicted: 0};
				reply({ok: true});
			} else if(op == 'stop') {
				delete agentSessions[tabId];
				delete agentCounters[tabId];
				delete tab_listeners[tabId];
				detachDebuggerFromTab(tabId);
				chrome.storage.session.set({agentMode: true, agentSessions: agentSessions});
				chrome.tabs.sendMessage(tabId, {type: 'agent-config', settings: agentPageConfig(tabId)}, function() { void chrome.runtime.lastError; });
				reply({ok: true});
			} else reply({ok: false, error: 'Unknown operation'});
		} catch(error) { reply({ok: false, error: error.message}); }
	});
}

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
	if(msg && msg.type == 'agent-get-config') {
		sendResponse({agentMode: agentMode, settings: agentMode ? agentPageConfig(sender.tab ? sender.tab.id : -1) : null});
		return;
	}
	if(msg && msg.type == 'agent-control') {
		if(!sender || sender.id != chrome.runtime.id || sender.url != chrome.runtime.getURL('control.html')) {
			sendResponse({ok: false, error: 'Control page required'});
			return;
		}
		handleAgentControl(msg, sendResponse);
		return true;
	}
	var tabId = sender.tab ? sender.tab.id : null;
	if(msg.listener || msg.eventType) {
		if(msg.listener == 'function () { [native code] }') return;
		if(tabId === null) return;
		if(agentMode && !agentSession(tabId)) return;
		if(agentMode && sender.tab && agentSession(tabId) && /^https?:/.test(sender.tab.url || '') &&
			new URL(sender.tab.url).origin != agentSession(tabId).origin) return;
		msg.parent_url = sender.tab.url;
		recordEvent(tabId, msg);
	}
	if(msg.pushState && tabId !== null) {
		tab_push[tabId] = true;
	}
	if(msg.changePage && tabId !== null) {
		delete tab_lasturl[tabId];
	}
	if(msg.log && !agentMode) {
		console.log(msg.log);
	}
});

chrome.tabs.onUpdated.addListener(function(tabId, props, tab) {
	if(agentMode && agentSession(tabId) && tab && isTrackableTab(tab) && new URL(tab.url).origin != agentSession(tabId).origin) detachDebuggerFromTab(tabId);
	if(agentMode && agentSession(tabId) && tab && isTrackableTab(tab)) attachDebuggerToTab(tab);
	if(props.status == "complete") {
		attachDebuggerToTab(tab);
		if(agentMode && agentSession(tabId)) chrome.tabs.sendMessage(tabId, {type: 'agent-config', settings: agentPageConfig(tabId)}, function() { void chrome.runtime.lastError; });
		refreshCount(tabId);
	} else if(props.status) {
		if(tab_push[tabId]) {
			delete tab_push[tabId];
		} else if(!tab_lasturl[tabId]) {
			tab_listeners[tabId] = [];
			broadcastState();
		}
	}
	if(props.status == "loading") {
		tab_lasturl[tabId] = true;
	}
});

chrome.tabs.onActivated.addListener(function(activeInfo) {
	selectedId = activeInfo.tabId;
	refreshCount();
	broadcastState();
});

chrome.tabs.onRemoved.addListener(function(tabId) {
	detachDebuggerFromTab(tabId);
	delete agentSessions[tabId];
	delete agentCounters[tabId];
	delete tab_listeners[tabId];
	delete tab_push[tabId];
	delete tab_lasturl[tabId];
	if(selectedId == tabId) selectedId = -1;
	broadcastState();
});

chrome.tabs.onCreated.addListener(function(tab) {
	attachDebuggerToTab(tab);
});

chrome.debugger.onEvent.addListener(function(source, method, params) {
	if(method.indexOf('Network.webSocket') === 0) {
		handleDebuggerNetworkEvent(source, method, params);
		return;
	}
	if(method.indexOf('Network.request') === 0 || method.indexOf('Network.response') === 0 || method == 'Network.loadingFinished' || method == 'Network.loadingFailed') {
		handleHttpNetworkEvent(source, method, params);
	}
});

chrome.debugger.onDetach.addListener(function(source, reason) {
	if(source.tabId) {
		delete attachedDebuggerTabs[source.tabId];
		clearDebuggerState(source.tabId);
	}
	console.log('debugger detached', source.tabId, reason);
	broadcastState();
});

chrome.runtime.onConnect.addListener(function(port) {
	connectedPorts.push(port);
	port.onDisconnect.addListener(function() {
		for(var i = connectedPorts.length - 1; i >= 0; i--) {
			if(connectedPorts[i] === port) connectedPorts.splice(i, 1);
		}
	});
	port.onMessage.addListener(function(msg) {
		if(msg === "get-stuff" || (msg && msg.type == 'get-state')) {
			port.postMessage(getStatePayload());
			return;
		}
		if(msg && msg.type == 'update-settings') {
			updateSettings(msg.settings || {}, function() {
				port.postMessage(getStatePayload());
			});
			return;
		}
		if(msg && msg.type == 'stop-capturing') {
			stopCapturing(function() {
				port.postMessage(getStatePayload());
			});
			return;
		}
		if(msg && msg.type == 'start-capturing') {
			startCapturing(function() {
				port.postMessage(getStatePayload());
			});
			return;
		}
		if(msg && msg.type == 'clear-all-captured-data') {
			clearAllCapturedData(function() {
				port.postMessage(getStatePayload());
			});
			return;
		}
			if(msg && msg.type == 'clear-history') {
				if(typeof msg.tabId == 'number') {
					tab_listeners[msg.tabId] = [];
					refreshCount(msg.tabId);
				} else {
					tab_listeners = {};
				chrome.tabs.query({}, function(tabs) {
					for(var i = 0; i < tabs.length; i++) refreshCount(tabs[i].id);
					});
				}
				if(settings.enable_persistent_archive) scheduleArchivePersist();
				else clearPersistentArchive();
				broadcastState();
				return;
			}
			if(msg && msg.type == 'clear-persistent-archive') {
				clearPersistentArchive(function() {
					if(!settings.enable_persistent_archive) {
						tab_listeners = {};
					}
					broadcastState();
				});
				return;
			}
			if(msg && msg.type == 'open-history-page') {
				chrome.tabs.create({url: chrome.runtime.getURL('history.html')});
				return;
			}
			if(msg && msg.type == 'open-resend-page') {
				openResendPage(buildResendDraft(msg));
				return;
			}
			if(msg && msg.type == 'get-resend-draft') {
				getResendDraft(msg.draftId, function(draft) {
					port.postMessage({type: 'resend-draft', draft: draft});
				});
				return;
			}
			if(msg && msg.type == 'run-resend' && msg.draft) {
				replayDraft(msg.draft, function(result) {
					port.postMessage({type: 'resend-result', result: result});
				});
			}
		});
	port.postMessage(getStatePayload());
});

chrome.storage.session.get({agentMode: false, agentSessions: {}}, function(agentState) {
	agentMode = !!agentState.agentMode;
	agentSessions = agentState.agentSessions || {};
	loadSettings(function() {
	 loadPersistentArchive(function() {
		if(agentMode) tab_listeners = {};
		chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
			if(tabs.length) selectedId = tabs[0].id;
			refreshCount();
			broadcastState();
		});
		syncDebuggers();
	 });
 });
});
