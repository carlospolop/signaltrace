var port = chrome.runtime.connect({
	name: 'History Communication'
});
var latestState = {listeners: {}, settings: {}, selectedId: null};

function option(label, value) {
	var el = document.createElement('option');
	el.value = value;
	el.textContent = label;
	return el;
}

function eventMatchesFilter(event, filterValue) {
	var api = (event.api || '').toLowerCase();
	var isWebSocket = api.indexOf('websocket') !== -1;
	var isPostMessage = !isWebSocket && (api.indexOf('message') !== -1 || api.indexOf('postmessage') !== -1);
	if(filterValue == 'listener') return event.eventType == 'listener';
	if(filterValue == 'traffic') return event.eventType == 'traffic';
	if(filterValue == 'ws') return isWebSocket;
	if(filterValue == 'postmessage') return isPostMessage;
	if(filterValue == 'http') return event.eventType == 'http' || api.indexOf('http') !== -1;
	return true;
}

function eventMatchesSearch(event, searchTerm) {
	if(!searchTerm) return true;
	searchTerm = searchTerm.toLowerCase();
	var haystack = [
		event.api || '',
		event.target || '',
		event.listener || '',
		event.payload || '',
		event.parent_url || '',
		event.domain || '',
		event.meta ? JSON.stringify(event.meta) : ''
	].join('\n').toLowerCase();
	return haystack.indexOf(searchTerm) !== -1;
}

function getChannelLabel(event) {
	var api = (event.api || '').toLowerCase();
	if(api.indexOf('websocket') !== -1) return 'WebSocket';
	if(api.indexOf('message') !== -1 || api.indexOf('postmessage') !== -1) return 'postMessage';
	if(event.eventType == 'http' || api.indexOf('http') !== -1) return 'HTTP';
	return 'Other';
}

function getChannelClass(event) {
	var label = getChannelLabel(event);
	if(label == 'WebSocket') return 'ws';
	if(label == 'HTTP') return 'http';
	return 'pm';
}

function isReplayable(event) {
	if(!event || !event.api) return false;
	if(event.eventType == 'listener') return false;
	var api = event.api.toLowerCase();
	return api.indexOf('websocket') !== -1 || api.indexOf('message') !== -1 || api.indexOf('postmessage') !== -1 || event.eventType == 'http' || api.indexOf('http') !== -1;
}

function openResend(tabId, entry) {
	port.postMessage({
		type: 'open-resend-page',
		tabId: parseInt(tabId, 10),
		event: entry
	});
}

function populateTabs() {
	var select = document.getElementById('tab-filter');
	var currentValue = select.value || 'all';
	select.innerHTML = '';
	select.appendChild(option('All tabs', 'all'));
	var keys = Object.keys(latestState.listeners).sort(function(a, b) { return parseInt(a, 10) - parseInt(b, 10); });
	for(var i = 0; i < keys.length; i++) {
		var tabId = keys[i];
		var events = latestState.listeners[tabId] || [];
		var label = 'Tab ' + tabId;
		if(events.length && events[events.length - 1].parent_url) {
			label += ' - ' + events[events.length - 1].parent_url;
		}
		select.appendChild(option(label, tabId));
	}
	select.value = currentValue;
	if(select.value != currentValue) select.value = 'all';
}

function getVisibleEvents() {
	var typeFilter = document.getElementById('type-filter').value;
	var tabFilter = document.getElementById('tab-filter').value;
	var searchTerm = document.getElementById('search').value.trim();
	var events = [];
	var keys = tabFilter == 'all' ? Object.keys(latestState.listeners) : [tabFilter];
	for(var i = 0; i < keys.length; i++) {
		var tabId = keys[i];
		var entries = latestState.listeners[tabId] || [];
		for(var j = 0; j < entries.length; j++) {
			var entry = entries[j];
			if(eventMatchesFilter(entry, typeFilter) && eventMatchesSearch(entry, searchTerm)) {
				events.push({tabId: tabId, entry: entry});
			}
		}
	}
	events.sort(function(a, b) {
		return (b.entry.captured_at || 0) - (a.entry.captured_at || 0);
	});
	return events;
}

function render() {
	populateTabs();
	var events = getVisibleEvents();
	var summary = document.getElementById('summary');
	summary.textContent = events.length + ' events shown across ' + Object.keys(latestState.listeners).length + ' tabs';
	var results = document.getElementById('results');
	results.innerHTML = '';
	for(var i = 0; i < events.length; i++) {
		var wrapper = document.createElement('div');
		wrapper.className = 'card';
		var entry = events[i].entry;
		var badges = document.createElement('div');
		badges.className = 'badges';
		var channelBadge = document.createElement('span');
		channelBadge.className = 'badge ' + getChannelClass(entry);
		channelBadge.textContent = getChannelLabel(entry);
		badges.appendChild(channelBadge);
			var typeBadge = document.createElement('span');
			var typeClass = entry.eventType == 'http' ? 'http_event' : (entry.eventType || 'traffic');
			typeBadge.className = 'badge ' + typeClass;
			typeBadge.textContent = entry.eventType || 'event';
		badges.appendChild(typeBadge);
		var head = document.createElement('div');
		head.className = 'card-head';
		var title = document.createElement('strong');
		title.textContent = '[' + events[i].tabId + '] ' + (entry.eventType || '') + ' ' + (entry.api || '');
		var titleWrap = document.createElement('div');
		titleWrap.appendChild(badges);
		titleWrap.appendChild(title);
		head.appendChild(titleWrap);
		if(isReplayable(entry)) {
			var actions = document.createElement('div');
			actions.className = 'card-actions';
			var resendButton = document.createElement('button');
			resendButton.className = 'secondary resend';
			resendButton.textContent = 'Resend';
			(function(tabId, eventEntry) {
				resendButton.addEventListener('click', function() {
					openResend(tabId, eventEntry);
				});
			})(events[i].tabId, entry);
			actions.appendChild(resendButton);
			head.appendChild(actions);
		}
		wrapper.appendChild(head);
		var meta = document.createElement('code');
		meta.textContent = (entry.parent_url || '') + '\n' + (entry.target || '') + ' ' + (entry.direction || '') + '\n' + new Date(entry.captured_at || Date.now()).toLocaleString();
		wrapper.appendChild(meta);
		var body = document.createElement('pre');
		body.textContent = (entry.listener || '') + (entry.payload ? '\n' + entry.payload : '') + (entry.meta ? '\n' + JSON.stringify(entry.meta, null, 2) : '');
		wrapper.appendChild(body);
		results.appendChild(wrapper);
	}
}

function init() {
	port.onMessage.addListener(function(msg) {
		latestState = msg;
		render();
	});
	port.postMessage({type: 'get-state'});
	document.getElementById('tab-filter').addEventListener('change', render);
	document.getElementById('type-filter').addEventListener('change', render);
	document.getElementById('search').addEventListener('input', render);
	document.getElementById('refresh').addEventListener('click', function() {
		port.postMessage({type: 'get-state'});
	});
	document.getElementById('clear-all').addEventListener('click', function() {
		port.postMessage({type: 'clear-history'});
	});
}

window.onload = init;
