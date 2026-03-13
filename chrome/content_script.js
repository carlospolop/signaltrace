function withRuntime(callback) {
	try {
		if(!chrome || !chrome.runtime || !chrome.runtime.id) return false;
		callback();
		return true;
	} catch (e) {
		return false;
	}
}

document.addEventListener('postMessageTracker', function(event) {
	withRuntime(function() {
		chrome.runtime.sendMessage(event.detail);
	});
});

function dispatchTrackerSettings() {
	withRuntime(function() {
		chrome.storage.sync.get({
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
			if(chrome.runtime.lastError) return;
			document.dispatchEvent(new CustomEvent('postMessageTrackerConfig', {detail: items}));
		});
	});
}

function logConsoleEvent(event) {
	var label = '[EVENT]';
	var api = (event.api || '').toLowerCase();
	if(event.eventType == 'http' || api.indexOf('http') !== -1) {
		label = '[HTTP]';
		console.log(
			label + '\n[REQUEST] ' + ((event.meta && event.meta.method) || '') + ' ' + ((event.meta && event.meta.url) || event.target || '') + '\n[RESPONSE] ' + (event.listener || ''),
			event.meta || {}
		);
		return;
	}
	if(api.indexOf('websocket') !== -1) {
		label = event.direction == 'send' ? '[WS CLIENT]' : '[WS SERVER]';
	} else if(api.indexOf('message') !== -1 || api.indexOf('postmessage') !== -1) {
		label = event.direction == 'send' ? '[PM SEND]' : '[PM RECV]';
	}
	var target = event.target ? ' ' + event.target : '';
	var payload = event.payload ? '\n' + event.payload : '';
	console.log(label + ' ' + (event.api || '') + target + payload, event.meta || {});
}

chrome.runtime.onMessage.addListener(function(message) {
	if(message && message.type == 'postMessageTrackerConsoleEvent' && message.event) {
		logConsoleEvent(message.event);
	}
});

withRuntime(function() {
	chrome.storage.onChanged.addListener(function(changes, areaName) {
		if(areaName == 'sync') dispatchTrackerSettings();
	});
});

document.addEventListener('postMessageTrackerRequestConfig', function() {
	dispatchTrackerSettings();
});

dispatchTrackerSettings();

//we use this to separate fragment changes with location changes
window.addEventListener('beforeunload', function(event) {
	var storeEvent = new CustomEvent('postMessageTracker', {'detail':{changePage:true}});
	document.dispatchEvent(storeEvent);
});
