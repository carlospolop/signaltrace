var port = chrome.runtime.connect({
	name: "Popup Communication"
});
var latestState = {listeners: {}, settings: {}, selectedId: null};
var settingsDirty = false;
var filterContainers = [
	{id: 'postmessage-filters', key: 'postmessage_filter', placeholder: 'Optional regex or substring'},
	{id: 'client-ws-filters', key: 'client_ws_filter', placeholder: 'Optional regex or substring'},
	{id: 'server-ws-filters', key: 'server_ws_filter', placeholder: 'Optional regex or substring'},
	{id: 'http-filters', key: 'http_filter', placeholder: 'Optional regex or substring'}
];

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

function collectFilterValues(containerId) {
	var container = document.getElementById(containerId);
	var values = [];
	var inputs = container.querySelectorAll('input');
	for(var i = 0; i < inputs.length; i++) {
		var value = inputs[i].value.trim();
		if(value) values.push(value);
	}
	return values;
}

function ensureTrailingEmptyInput(containerId) {
	var container = document.getElementById(containerId);
	var inputs = container.querySelectorAll('input');
	if(!inputs.length || inputs[inputs.length - 1].value.trim().length > 0) {
		var input = document.createElement('input');
		input.type = 'text';
		input.placeholder = 'Optional regex or substring';
		input.addEventListener('input', function() {
			markSettingsDirty();
			ensureTrailingEmptyInput(containerId);
		});
		container.appendChild(input);
	}
}

function renderFilterInputs() {
	if(settingsDirty) return;
	for(var i = 0; i < filterContainers.length; i++) {
		var config = filterContainers[i];
		var container = document.getElementById(config.id);
		container.innerHTML = '';
		var values = normalizeFilterList(latestState.settings[config.key]);
		for(var j = 0; j < values.length; j++) {
			var input = document.createElement('input');
			input.type = 'text';
			input.placeholder = config.placeholder;
			input.value = values[j];
			input.addEventListener('input', (function(containerId) {
				return function() {
					markSettingsDirty();
					ensureTrailingEmptyInput(containerId);
				};
			})(config.id));
			container.appendChild(input);
		}
		ensureTrailingEmptyInput(config.id);
	}
}

function eventMatchesFilter(listener, filterValue) {
	var api = (listener.api || '').toLowerCase();
	var isWebSocket = api.indexOf('websocket') !== -1;
	var isPostMessage = !isWebSocket && (api.indexOf('message') !== -1 || api.indexOf('postmessage') !== -1);
	if(filterValue == 'listener') return listener.eventType == 'listener';
	if(filterValue == 'traffic') return listener.eventType == 'traffic';
	if(filterValue == 'ws') return isWebSocket;
	if(filterValue == 'postmessage') return isPostMessage;
	if(filterValue == 'http') return listener.eventType == 'http' || (listener.api || '').toLowerCase().indexOf('http') !== -1;
	return true;
}

function renderEvents() {
	var listeners = latestState.listeners[latestState.selectedId] || [];
	var filterValue = document.getElementById('type-filter').value;
	listeners = listeners.slice().reverse().filter(function(listener) {
		return eventMatchesFilter(listener, filterValue);
	});

	var listenerCount = 0;
	var trafficCount = 0;
	var httpCount = 0;
	var allCurrent = latestState.listeners[latestState.selectedId] || [];
	for(var i = 0; i < allCurrent.length; i++) {
		if(allCurrent[i].eventType == 'traffic') trafficCount++;
		else if(allCurrent[i].eventType == 'http') httpCount++;
		else listenerCount++;
	}

	document.getElementById('h').innerText = (listeners.length ? listeners[0].parent_url : '') + '\n' + listenerCount + ' listeners, ' + trafficCount + ' traffic events, ' + httpCount + ' http events';
	var list = document.getElementById('events');
	list.innerHTML = '';
	for(var j = 0; j < listeners.length; j++) {
		var listener = listeners[j];
		var el = document.createElement('li');
		var bold = document.createElement('b');
		var prefix = listener.eventType == 'traffic' ? '[traffic] ' : (listener.eventType == 'http' ? '[http] ' : '[listener] ');
		bold.innerText = prefix + (listener.domain || '') + ' ' + (listener.api || '');
		el.appendChild(bold);

		var code = document.createElement('code');
		code.innerText = ' ' + (listener.target || '') + ' ' + (listener.direction || '');
		el.appendChild(code);

		var span = document.createElement('span');
		if(listener.fullstack) span.setAttribute('title', listener.fullstack.join("\n\n"));
		var timestamp = listener.captured_at ? new Date(listener.captured_at).toLocaleTimeString() + ' ' : '';
		var meta = listener.meta ? ' ' + JSON.stringify(listener.meta) : '';
		span.innerText = timestamp + (listener.stack || '') + meta;
		el.appendChild(span);

		var pre = document.createElement('pre');
		pre.innerText = listener.payload ? listener.listener + "\n" + listener.payload : listener.listener;
		el.appendChild(pre);
		list.appendChild(el);
	}
}

function renderSettings() {
	if(settingsDirty) return;
	document.getElementById('enable-debugger').checked = latestState.settings.enable_debugger !== false;
	document.getElementById('enable-persistent-archive').checked = latestState.settings.enable_persistent_archive === true;
	document.getElementById('enable-postmessage').checked = latestState.settings.enable_postmessage !== false;
	document.getElementById('filter-null-postmessage').checked = latestState.settings.filter_null_postmessage !== false;
	document.getElementById('enable-client-ws').checked = latestState.settings.enable_client_ws !== false;
	document.getElementById('enable-server-ws').checked = latestState.settings.enable_server_ws !== false;
	document.getElementById('enable-http').checked = latestState.settings.enable_http !== false;
	document.getElementById('enable-http-request-bodies').checked = latestState.settings.enable_http_request_bodies !== false;
	document.getElementById('enable-http-response-bodies').checked = latestState.settings.enable_http_response_bodies !== false;
	renderFilterInputs();
	document.getElementById('max-events').value = latestState.settings.max_events_per_tab || 1000;
	document.getElementById('log-url').value = latestState.settings.log_url || '';
}

function renderState(msg) {
	latestState = msg;
	renderSettings();
	renderEvents();
}

function showStatus(text) {
	var status = document.getElementById('status');
	status.textContent = text;
	setTimeout(function() {
		if(status.textContent == text) status.textContent = '';
	}, 1500);
}

function saveSettings() {
	settingsDirty = false;
	port.postMessage({
		type: 'update-settings',
			settings: {
				enable_debugger: document.getElementById('enable-debugger').checked,
				enable_persistent_archive: document.getElementById('enable-persistent-archive').checked,
				enable_postmessage: document.getElementById('enable-postmessage').checked,
			filter_null_postmessage: document.getElementById('filter-null-postmessage').checked,
			enable_client_ws: document.getElementById('enable-client-ws').checked,
			enable_server_ws: document.getElementById('enable-server-ws').checked,
			enable_http: document.getElementById('enable-http').checked,
			enable_http_request_bodies: document.getElementById('enable-http-request-bodies').checked,
			enable_http_response_bodies: document.getElementById('enable-http-response-bodies').checked,
			postmessage_filter: collectFilterValues('postmessage-filters'),
			client_ws_filter: collectFilterValues('client-ws-filters'),
			server_ws_filter: collectFilterValues('server-ws-filters'),
			http_filter: collectFilterValues('http-filters'),
			max_events_per_tab: parseInt(document.getElementById('max-events').value, 10) || 1000,
			log_url: document.getElementById('log-url').value
		}
	});
	showStatus('Settings saved.');
}

function markSettingsDirty() {
	settingsDirty = true;
}

function init() {
	port.onMessage.addListener(renderState);
	port.postMessage({type: 'get-state'});

	document.getElementById('save').addEventListener('click', saveSettings);
	document.getElementById('open-history').addEventListener('click', function() {
		port.postMessage({type: 'open-history-page'});
	});
		document.getElementById('clear-tab').addEventListener('click', function() {
			port.postMessage({type: 'clear-history', tabId: latestState.selectedId});
		});
		document.getElementById('clear-archive').addEventListener('click', function() {
			port.postMessage({type: 'clear-persistent-archive'});
			showStatus('Stored archive cleared.');
		});
		document.getElementById('type-filter').addEventListener('change', renderEvents);
		document.getElementById('enable-debugger').addEventListener('change', markSettingsDirty);
		document.getElementById('enable-persistent-archive').addEventListener('change', markSettingsDirty);
		document.getElementById('enable-postmessage').addEventListener('change', markSettingsDirty);
	document.getElementById('filter-null-postmessage').addEventListener('change', markSettingsDirty);
	document.getElementById('enable-client-ws').addEventListener('change', markSettingsDirty);
	document.getElementById('enable-server-ws').addEventListener('change', markSettingsDirty);
	document.getElementById('enable-http').addEventListener('change', markSettingsDirty);
	document.getElementById('enable-http-request-bodies').addEventListener('change', markSettingsDirty);
	document.getElementById('enable-http-response-bodies').addEventListener('change', markSettingsDirty);
	document.getElementById('max-events').addEventListener('input', markSettingsDirty);
	document.getElementById('log-url').addEventListener('input', markSettingsDirty);
	renderFilterInputs();
}

window.onload = init;
