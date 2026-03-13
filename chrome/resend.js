var port = chrome.runtime.connect({
	name: 'Resend Communication'
});
var latestDraft = null;
var draftId = '';

function $(id) {
	return document.getElementById(id);
}

function stringifyJson(value) {
	try {
		return JSON.stringify(value || {}, null, 2);
	} catch (e) {
		return '{}';
	}
}

function getBadgeClass(kind) {
	if(kind == 'websocket') return 'ws';
	if(kind == 'http') return 'http';
	return 'pm';
}

function setStatus(kind, text) {
	var status = $('status');
	status.className = 'status ' + (kind || '');
	status.textContent = text || '';
	if(!text) status.classList.add('hidden');
	else status.classList.remove('hidden');
}

function renderOriginal(draft) {
	var original = draft && draft.original ? draft.original : {};
	$('original').textContent = JSON.stringify(original, null, 2);
	$('original-meta').textContent = [
		'Captured: ' + (original.captured_at ? new Date(original.captured_at).toLocaleString() : 'unknown'),
		'API: ' + (original.api || 'unknown'),
		'Direction: ' + (original.direction || 'unknown')
	].join('\n');
}

function syncVisibility(kind) {
	$('http-method-row').classList.toggle('hidden', kind != 'http');
	$('headers-row').classList.toggle('hidden', kind != 'http');
	$('pm-target-origin-row').classList.toggle('hidden', kind != 'postmessage');
}

function renderDraft(draft) {
	latestDraft = draft;
	var kind = draft && draft.kind ? draft.kind : 'postmessage';
	$('draft-kind').value = kind;
	$('draft-url').value = kind == 'postmessage' ? '' : (draft.url || '');
	$('draft-method').value = draft.method || 'GET';
	$('draft-target-origin').value = draft.targetOrigin || '*';
	$('draft-headers').value = stringifyJson(draft.headers || {});
	$('draft-payload').value = kind == 'http' ? (draft.body || '') : (draft.payload || '');
	$('kind-badge').textContent = kind;
	$('kind-badge').className = 'badge ' + getBadgeClass(kind);
	$('tab-badge').textContent = 'Tab ' + (draft.tabId || '?');
	renderOriginal(draft);
	syncVisibility(kind);
	setStatus('', '');
}

function collectDraft() {
	var draft = {
		kind: $('draft-kind').value,
		tabId: latestDraft ? latestDraft.tabId : null,
		original: latestDraft ? latestDraft.original : null
	};
	if(draft.kind == 'http') {
		var headersText = $('draft-headers').value.trim();
		if(!headersText) headersText = '{}';
		try {
			draft.headers = JSON.parse(headersText);
		} catch (e) {
			throw new Error('Headers JSON is invalid: ' + e.message);
		}
		draft.url = $('draft-url').value.trim();
		draft.method = $('draft-method').value.trim() || 'GET';
		draft.body = $('draft-payload').value;
		return draft;
	}
	if(draft.kind == 'websocket') {
		draft.url = $('draft-url').value.trim();
		draft.payload = $('draft-payload').value;
		return draft;
	}
	draft.targetOrigin = $('draft-target-origin').value.trim() || '*';
	draft.payload = $('draft-payload').value;
	return draft;
}

function requestDraft() {
	port.postMessage({type: 'get-resend-draft', draftId: draftId});
}

function init() {
	draftId = new URLSearchParams(window.location.search).get('draft') || '';
	port.onMessage.addListener(function(msg) {
		if(msg && msg.type == 'resend-draft') {
			if(msg.draft) renderDraft(msg.draft);
			else setStatus('error', 'No resend draft available. Open this page from a capture entry in history.');
			return;
		}
		if(msg && msg.type == 'resend-result') {
			if(msg.result && msg.result.ok) {
				setStatus('ok', 'Replay sent successfully.\n\n' + JSON.stringify(msg.result, null, 2));
			} else {
				setStatus('error', 'Replay failed.\n\n' + JSON.stringify(msg.result || {}, null, 2));
			}
		}
	});
	$('resend').addEventListener('click', function() {
		try {
			var draft = collectDraft();
			if(!draft.tabId) {
				setStatus('error', 'Missing original tab id.');
				return;
			}
			port.postMessage({type: 'run-resend', draft: draft});
			setStatus('', 'Sending...');
		} catch (error) {
			setStatus('error', error.message);
		}
	});
	$('reload').addEventListener('click', requestDraft);
	requestDraft();
}

window.onload = init;
