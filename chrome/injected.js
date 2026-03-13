/*
History is needed to hijack pushState-changes
addEventListener to hijack the message-handlers getting registered
defineSetter to handle old way of setting onmessage
beforeunload to track page changes (since we see no diff btw fragmentchange/pushstate and real location change

we also look for event.dispatch.apply in the listener, if it exists, we find a earlier stack-row and use that one
also, we look for jQuery-expandos to identify events being added later on by jQuery's dispatcher
*/
(function(pushstate, msgeventlistener, msgporteventlistener) {
	if(document.contentType == 'application/xml') {
		return;
	}
	var loaded = false;
	var originalFunctionToString = Function.prototype.toString;
	var originalWindowPostMessage = window.postMessage;
	var originalPortPostMessage = typeof MessagePort !== 'undefined' ? MessagePort.prototype.postMessage : null;
	var originalBroadcastChannelPostMessage = typeof BroadcastChannel !== 'undefined' ? BroadcastChannel.prototype.postMessage : null;
	var originalWorkerPostMessage = typeof Worker !== 'undefined' ? Worker.prototype.postMessage : null;
	var originalSharedWorkerPostMessage = typeof SharedWorker !== 'undefined' && SharedWorker.prototype ? SharedWorker.prototype.postMessage : null;
	var originalWorkerAddEventListener = typeof Worker !== 'undefined' ? Worker.prototype.addEventListener : null;
	var originalMessagePortSetter = typeof MessagePort !== 'undefined' ? MessagePort.prototype.__lookupSetter__('onmessage') : null;
	var originalBroadcastChannelSetter = typeof BroadcastChannel !== 'undefined' ? BroadcastChannel.prototype.__lookupSetter__('onmessage') : null;
	var originalWorkerSetter = typeof Worker !== 'undefined' ? Worker.prototype.__lookupSetter__('onmessage') : null;
	var originalSharedWorkerSetter = typeof SharedWorker !== 'undefined' && SharedWorker.prototype ? SharedWorker.prototype.__lookupSetter__('onmessage') : null;
	var NativeWebSocket = typeof WebSocket !== 'undefined' ? WebSocket : null;
	var originalWebSocketSend = NativeWebSocket ? NativeWebSocket.prototype.send : null;
	var originalWebSocketAddEventListener = NativeWebSocket ? NativeWebSocket.prototype.addEventListener : null;
	var originalWebSocketMessageSetter = NativeWebSocket ? NativeWebSocket.prototype.__lookupSetter__('onmessage') : null;
	var originalWebSocketOpenSetter = NativeWebSocket ? NativeWebSocket.prototype.__lookupSetter__('onopen') : null;
	var originalWebSocketCloseSetter = NativeWebSocket ? NativeWebSocket.prototype.__lookupSetter__('onclose') : null;
	var originalWebSocketErrorSetter = NativeWebSocket ? NativeWebSocket.prototype.__lookupSetter__('onerror') : null;
	var websocketCounter = 0;
	var trackerConfig = {
		enable_postmessage: true,
		enable_client_ws: true,
		enable_server_ws: true,
		filter_null_postmessage: true,
		postmessage_filter: [],
		client_ws_filter: [],
		server_ws_filter: []
	};

	var m = function(detail) {
		var storeEvent = new CustomEvent('postMessageTracker', {'detail': detail});
		document.dispatchEvent(storeEvent);
	};

	var updateConfig = function(nextConfig) {
		if(!nextConfig) return;
		for(var key in nextConfig) {
			trackerConfig[key] = nextConfig[key];
		}
	};

	document.addEventListener('postMessageTrackerConfig', function(event) {
		updateConfig(event.detail || {});
	});
	document.dispatchEvent(new CustomEvent('postMessageTrackerRequestConfig'));

	var markInternal = function(fn) {
		if(typeof fn == 'function') {
			fn.__postmessagetrackerinternal__ = true;
		}
		return fn;
	};

	var h = function(p) {
		var hops = "";
		try {
			if(!p) {
				p = window;
			}
			if(p.top != p && p.top == window.top) {
				var w = p;
				while(top != w) {
					var x = 0;
					for(var i = 0; i < w.parent.frames.length; i++) {
						if(w == w.parent.frames[i]) {
							x = i;
						}
					}
					hops = "frames[" + x + "]" + (hops.length ? '.' : '') + hops;
					w = w.parent;
				}
				hops = "top" + (hops.length ? '.' + hops : '');
			} else {
				hops = p.top == window.top ? "top" : "diffwin";
			}
		} catch(e) {
		}
		return hops;
	};

	var safeToString = function(value) {
		try {
			if(typeof value == 'string') {
				return value;
			}
			if(typeof value == 'undefined') {
				return 'undefined';
			}
			return JSON.stringify(value);
		} catch (e) {
			try {
				return String(value);
			} catch (e2) {
				return '[unserializable]';
			}
		}
	};

	var normalizeFilterList = function(value) {
		if(Object.prototype.toString.call(value) == '[object Array]') {
			return value.filter(function(item) {
				return typeof item == 'string' && item.trim().length > 0;
			});
		}
		if(typeof value == 'string' && value.trim().length > 0) {
			return [value.trim()];
		}
		return [];
	};

	var matchesRegexFilter = function(pattern, value) {
		if(!pattern) {
			return false;
		}
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
	};

	var matchesAnyFilter = function(patterns, value) {
		var normalizedPatterns = normalizeFilterList(patterns);
		for(var i = 0; i < normalizedPatterns.length; i++) {
			if(matchesRegexFilter(normalizedPatterns[i], value)) {
				return true;
			}
		}
		return false;
	};

	var getStack = function(offset) {
		var stack;
		try {
			throw new Error('');
		} catch (error) {
			stack = error.stack || '';
		}
		return stack.split('\n').map(function(line) {
			return line.trim();
		}).slice(offset || 0);
	};

	var serializeTarget = function(target) {
		if(target === window) {
			return 'window';
		}
		if(NativeWebSocket && target instanceof NativeWebSocket) {
			return 'WebSocket(' + (target.__postmessagetrackerid__ || '?') + ')';
		}
		if(typeof MessagePort !== 'undefined' && target instanceof MessagePort) {
			return 'MessagePort';
		}
		if(typeof BroadcastChannel !== 'undefined' && target instanceof BroadcastChannel) {
			return 'BroadcastChannel(' + target.name + ')';
		}
		if(typeof Worker !== 'undefined' && target instanceof Worker) {
			return 'Worker';
		}
		if(typeof SharedWorker !== 'undefined' && target instanceof SharedWorker) {
			return 'SharedWorker';
		}
		return Object.prototype.toString.call(target);
	};

	var describeWebSocket = function(socket) {
		var label = 'WebSocket(' + (socket.__postmessagetrackerid__ || '?') + ')';
		if(socket.__postmessagetrackerurl__) {
			label += ' ' + socket.__postmessagetrackerurl__;
		}
		return label;
	};

	var classifyChannel = function(api, direction) {
		var normalizedApi = (api || '').toLowerCase();
		if(normalizedApi.indexOf('websocket') !== -1) {
			return direction == 'send' ? 'client_ws' : 'server_ws';
		}
		if(normalizedApi.indexOf('message') !== -1 || normalizedApi.indexOf('postmessage') !== -1) {
			return 'postmessage';
		}
		return 'other';
	};

	var shouldCapture = function(api, direction, payload, target) {
		var channel = classifyChannel(api, direction);
		var haystack = [safeToString(payload), api || '', target || ''].join('\n');
		if(channel == 'postmessage') {
			if(trackerConfig.filter_null_postmessage && (payload === null || typeof payload == 'undefined' || safeToString(payload) == 'null')) {
				return false;
			}
			return trackerConfig.enable_postmessage && !matchesAnyFilter(trackerConfig.postmessage_filter, haystack);
		}
		if(channel == 'client_ws') {
			return trackerConfig.enable_client_ws && !matchesAnyFilter(trackerConfig.client_ws_filter, haystack);
		}
		if(channel == 'server_ws') {
			return trackerConfig.enable_server_ws && !matchesAnyFilter(trackerConfig.server_ws_filter, haystack);
		}
		return true;
	};

	var logCapturedTraffic = function(detail) {
		var kind = classifyChannel(detail.api, detail.direction);
		if(kind == 'other') {
			return;
		}
		var label = '[EVENT]';
		if(kind == 'postmessage') {
			label = detail.direction == 'send' ? '[PM SEND]' : '[PM RECV]';
		} else if(kind == 'client_ws') {
			label = '[WS CLIENT]';
		} else if(kind == 'server_ws') {
			label = '[WS SERVER]';
		}
		console.log(
			label + ' ' + (detail.api || '') + ' ' + (detail.target || '') + '\n' + (detail.payload || ''),
			detail.meta || {}
		);
	};

	var emitTraffic = function(detail) {
		if(!shouldCapture(detail.api, detail.direction, detail.payload, detail.target)) {
			return;
		}
		logCapturedTraffic(detail);
		m({
			window: window.top == window ? 'top' : window.name,
			hops: h(),
			domain: document.domain,
			captured_at: Date.now(),
			eventType: 'traffic',
			api: detail.api,
			direction: detail.direction,
			target: detail.target,
			stack: detail.stack,
			fullstack: detail.fullstack,
			listener: detail.listener,
			payload: detail.payload,
			meta: detail.meta
		});
	};

	var trackTraffic = function(direction, api, target, payload, extraOffset, meta) {
		var fullstack = getStack(2);
		emitTraffic({
			direction: direction,
			api: api,
			target: target,
			payload: safeToString(payload),
			stack: fullstack[(extraOffset || 0)],
			fullstack: fullstack,
			listener: direction + ' ' + api + ' ' + target,
			meta: meta || null
		});
	};

	var attachInternalMessageListener = function(target, api, fnAddEventListener) {
		if(!target || target.__postmessagetrackerattached__) {
			return;
		}
		target.__postmessagetrackerattached__ = true;
		var handler = markInternal(function(event) {
			trackTraffic('receive', api, serializeTarget(target), event.data, 1);
		});
		try {
			fnAddEventListener.call(target, 'message', handler);
		} catch (e) {
		}
	};

	var attachWebSocketInternalListeners = function(socket) {
		if(!socket || socket.__postmessagetrackerwsattached__ || !originalWebSocketAddEventListener) {
			return;
		}
		socket.__postmessagetrackerwsattached__ = true;
		var socketTarget = describeWebSocket(socket);
		try {
			originalWebSocketAddEventListener.call(socket, 'message', markInternal(function(event) {
				trackTraffic('receive', 'WebSocket.message', socketTarget, event.data, 1, {
					url: socket.__postmessagetrackerurl__ || null,
					readyState: socket.readyState
				});
			}));
			originalWebSocketAddEventListener.call(socket, 'open', markInternal(function() {
				trackTraffic('receive', 'WebSocket.open', socketTarget, '[open]', 1, {
					url: socket.__postmessagetrackerurl__ || null,
					readyState: socket.readyState
				});
			}));
			originalWebSocketAddEventListener.call(socket, 'close', markInternal(function(event) {
				trackTraffic('receive', 'WebSocket.close', socketTarget, '[close]', 1, {
					url: socket.__postmessagetrackerurl__ || null,
					code: event.code,
					reason: event.reason,
					wasClean: event.wasClean,
					readyState: socket.readyState
				});
			}));
			originalWebSocketAddEventListener.call(socket, 'error', markInternal(function() {
				trackTraffic('receive', 'WebSocket.error', socketTarget, '[error]', 1, {
					url: socket.__postmessagetrackerurl__ || null,
					readyState: socket.readyState
				});
			}));
		} catch (e) {
		}
	};

	var recordAssignedListener = function(api, target, listener) {
		if(typeof listener != 'function') {
			return;
		}
		if(!shouldCapture(api, 'receive', listener.__postmessagetrackername__ || listener.toString(), target)) {
			return;
		}
		var fullstack = getStack(2);
			m({
				window: window.top == window ? 'top' : window.name,
				hops: h(),
				domain: document.domain,
				captured_at: Date.now(),
				eventType: 'listener',
				api: api,
				target: target,
				stack: fullstack[0],
			fullstack: fullstack,
			listener: listener.__postmessagetrackername__ || listener.toString()
		});
	};

	var jq = function(instance) {
		if(!instance || !instance.message || !instance.message.length) {
			return;
		}
		var j = 0;
		var e;
		while((e = instance.message[j++])) {
			var listener = e.handler;
			if(!listener) {
				return;
			}
			if(!shouldCapture('jQuery.message', 'receive', listener.toString(), 'window')) {
				continue;
			}
			m({window: window.top == window ? 'top' : window.name, hops: h(), domain: document.domain, captured_at: Date.now(), eventType: 'listener', api: 'jQuery', target: 'window', stack: 'jQuery', listener: listener.toString()});
		}
	};

	var l = function(listener, pattern_before, additional_offset, api, target) {
		var offset = 3 + (additional_offset || 0);
		var stack = getStack(0);
		var fullstack = stack.slice();
		if(pattern_before) {
			var nextitem = false;
			stack = stack.filter(function(e) {
				if(nextitem) {
					nextitem = false;
					return true;
				}
				if(e.match(pattern_before)) {
					nextitem = true;
				}
				return false;
			});
			stack = stack[0];
		} else {
			stack = stack[offset];
		}
		var listener_str = listener.__postmessagetrackername__ || listener.toString();
		if(!shouldCapture(api || 'window', 'receive', listener_str, target || 'window')) {
			return;
		}
		m({window: window.top == window ? 'top' : window.name, hops: h(), domain: document.domain, captured_at: Date.now(), eventType: 'listener', api: api || 'window', target: target || 'window', stack: stack, fullstack: fullstack, listener: listener_str});
	};

	var jqc = function(key) {
		var expando;
		var instance;
		m({log: ['Found key', key, typeof window[key], window[key] ? window[key].toString() : window[key]]});
		if(typeof window[key] == 'function' && typeof window[key]._data == 'function') {
			m({log: ['found jq function', window[key].toString()]});
			var ev = window[key]._data(window, 'events');
			jq(ev);
		} else if(window[key] && (expando = window[key].expando)) {
			m({log: ['Use expando', expando]});
			var i = 1;
			while((instance = window[expando + i++])) {
				jq(instance.events);
			}
		} else if(window[key]) {
			m({log: ['Use events directly', window[key].toString()]});
			jq(window[key].events);
		}
	};

	var j = function() {
		m({log: 'Run jquery fetcher'});
		var all = Object.getOwnPropertyNames(window);
		var len = all.length;
		for(var i = 0; i < len; i++) {
			var key = all[i];
			if(key.indexOf('jQuery') !== -1) {
				jqc(key);
			}
		}
		loaded = true;
	};

	var c = function(listener) {
		var listener_str = originalFunctionToString.apply(listener);
		if(listener_str.match(/\.deep.*apply.*captureException/s)) {
			return 'raven';
		} else if(listener_str.match(/arguments.*(start|typeof).*err.*finally.*end/s) && listener["nr@original"] && typeof listener["nr@original"] == "function") {
			return 'newrelic';
		} else if(listener_str.match(/rollbarContext.*rollbarWrappedError/s) && listener._isWrap &&
					(typeof listener._wrapped == "function" || typeof listener._rollbar_wrapped == "function")) {
			return 'rollbar';
		} else if(listener_str.match(/autoNotify.*(unhandledException|notifyException)/s) && typeof listener.bugsnag == "function") {
			return 'bugsnag';
		} else if(listener_str.match(/call.*arguments.*typeof.*apply/s) && typeof listener.__sentry_original__ == "function") {
			return 'sentry';
		} else if(listener_str.match(/function.*function.*\.apply.*arguments/s) && typeof listener.__trace__ == "function") {
			return 'bugsnag2';
		}
		return false;
	};

	var unwrapWindowListener = function(listener, state) {
		var found = c(listener);
		if(found == 'raven') {
			var fb = false;
			var ff = false;
			var f;
			for(var key in listener) {
				var v = listener[key];
				if(typeof v == "function") {
					ff++;
					f = v;
				}
				if(typeof v == "boolean") {
					fb++;
				}
			}
			if(ff == 1 && fb == 1) {
				m({log: 'We got a raven wrapper'});
				state.offset++;
				listener = unwrapWindowListener(f, state);
			}
		} else if(found == 'newrelic') {
			m({log: 'We got a newrelic wrapper'});
			state.offset++;
			listener = unwrapWindowListener(listener["nr@original"], state);
		} else if(found == 'sentry') {
			m({log: 'We got a sentry wrapper'});
			state.offset++;
			listener = unwrapWindowListener(listener["__sentry_original__"], state);
		} else if(found == 'rollbar') {
			m({log: 'We got a rollbar wrapper'});
			state.offset += 2;
		} else if(found == 'bugsnag') {
			state.offset++;
			var clr = null;
			try {
				clr = arguments.callee.caller.caller.caller;
			} catch(e) {
			}
			if(clr && !c(clr)) {
				m({log: 'We got a bugsnag wrapper'});
				listener.__postmessagetrackername__ = clr.toString();
			} else if(clr) {
				state.offset++;
			}
		} else if(found == 'bugsnag2') {
			state.offset++;
			var clr2 = null;
			try {
				clr2 = arguments.callee.caller.caller.arguments[1];
			} catch(e) {
			}
			if(clr2 && !c(clr2)) {
				listener = unwrapWindowListener(clr2, state);
				m({log: 'We got a bugsnag2 wrapper'});
				listener.__postmessagetrackername__ = clr2.toString();
			} else if(clr2) {
				state.offset++;
			}
		}
		if(listener.name && listener.name.indexOf('bound ') === 0) {
			listener.__postmessagetrackername__ = listener.name;
		}
		return listener;
	};

	var onmsgport = markInternal(function(e) {
		if(!shouldCapture('MessagePort.message', 'receive', e.data, 'MessagePort')) {
			return;
		}
		var p = (e.ports && e.ports.length ? '%cport' + e.ports.length + '%c ' : '');
		var msg = '%cport%c→%c' + h(e.source) + '%c ' + p + (typeof e.data == 'string' ? e.data : 'j ' + safeToString(e.data));
		if(p.length) {
			console.log(msg, "color: blue", '', "color: red", '', "color: blue", '');
		} else {
			console.log(msg, "color: blue", '', "color: red", '');
		}
		trackTraffic('receive', 'MessagePort.message', 'MessagePort', e.data, 1);
	});

	var onmsg = markInternal(function(e) {
		if(!shouldCapture('window.message', 'receive', e.data, 'window')) {
			return;
		}
		var p = (e.ports && e.ports.length ? '%cport' + e.ports.length + '%c ' : '');
		var msg = '%c' + h(e.source) + '%c→%c' + h() + '%c ' + p + (typeof e.data == 'string' ? e.data : 'j ' + safeToString(e.data));
		if(p.length) {
			console.log(msg, "color: red", '', "color: green", '', "color: blue", '');
		} else {
			console.log(msg, "color: red", '', "color: green", '');
		}
		trackTraffic('receive', 'window.message', 'window', e.data, 1);
	});

	History.prototype.pushState = function(state, title, url) {
		m({pushState: true});
		return pushstate.apply(this, arguments);
	};

	var originalWindowSetter = window.__lookupSetter__('onmessage');
	if(originalWindowSetter) {
		window.__defineSetter__('onmessage', function(listener) {
			if(listener) {
				recordAssignedListener('window.onmessage', 'window', listener);
			}
			originalWindowSetter.call(this, listener);
		});
	}

	window.postMessage = function(message, targetOrigin, transfer) {
		trackTraffic('send', 'window.postMessage', 'window', message, 1, {targetOrigin: targetOrigin});
		return originalWindowPostMessage.apply(this, arguments);
	};

	window.addEventListener('message', onmsg);

	if(typeof MessagePort !== 'undefined') {
		MessagePort.prototype.addEventListener = function(type, listener, useCapture) {
			if(type == 'message' && typeof listener == 'function' && !listener.__postmessagetrackerinternal__) {
				recordAssignedListener('MessagePort.addEventListener', 'MessagePort', listener);
			}
			attachInternalMessageListener(this, 'MessagePort.message', msgporteventlistener);
			return msgporteventlistener.apply(this, arguments);
		};

		if(originalMessagePortSetter) {
			MessagePort.prototype.__defineSetter__('onmessage', function(listener) {
				recordAssignedListener('MessagePort.onmessage', 'MessagePort', listener);
				attachInternalMessageListener(this, 'MessagePort.message', msgporteventlistener);
				originalMessagePortSetter.call(this, listener);
			});
		}

		MessagePort.prototype.postMessage = function(message, transfer) {
			attachInternalMessageListener(this, 'MessagePort.message', msgporteventlistener);
			trackTraffic('send', 'MessagePort.postMessage', 'MessagePort', message, 1);
			return originalPortPostMessage.apply(this, arguments);
		};
	}

	if(typeof BroadcastChannel !== 'undefined') {
		var originalBroadcastChannelAddEventListener = BroadcastChannel.prototype.addEventListener;
		BroadcastChannel.prototype.addEventListener = function(type, listener, useCapture) {
			if(type == 'message' && typeof listener == 'function' && !listener.__postmessagetrackerinternal__) {
				recordAssignedListener('BroadcastChannel.addEventListener', 'BroadcastChannel(' + this.name + ')', listener);
			}
			attachInternalMessageListener(this, 'BroadcastChannel.message', originalBroadcastChannelAddEventListener);
			return originalBroadcastChannelAddEventListener.apply(this, arguments);
		};

		if(originalBroadcastChannelSetter) {
			BroadcastChannel.prototype.__defineSetter__('onmessage', function(listener) {
				recordAssignedListener('BroadcastChannel.onmessage', 'BroadcastChannel(' + this.name + ')', listener);
				attachInternalMessageListener(this, 'BroadcastChannel.message', BroadcastChannel.prototype.addEventListener);
				originalBroadcastChannelSetter.call(this, listener);
			});
		}

		BroadcastChannel.prototype.postMessage = function(message) {
			attachInternalMessageListener(this, 'BroadcastChannel.message', BroadcastChannel.prototype.addEventListener);
			trackTraffic('send', 'BroadcastChannel.postMessage', 'BroadcastChannel(' + this.name + ')', message, 1);
			return originalBroadcastChannelPostMessage.apply(this, arguments);
		};
	}

	if(typeof Worker !== 'undefined') {
		Worker.prototype.addEventListener = function(type, listener, useCapture) {
			if(type == 'message' && typeof listener == 'function' && !listener.__postmessagetrackerinternal__) {
				recordAssignedListener('Worker.addEventListener', 'Worker', listener);
			}
			attachInternalMessageListener(this, 'Worker.message', originalWorkerAddEventListener);
			return originalWorkerAddEventListener.apply(this, arguments);
		};

		if(originalWorkerSetter) {
			Worker.prototype.__defineSetter__('onmessage', function(listener) {
				recordAssignedListener('Worker.onmessage', 'Worker', listener);
				attachInternalMessageListener(this, 'Worker.message', originalWorkerAddEventListener);
				originalWorkerSetter.call(this, listener);
			});
		}

		Worker.prototype.postMessage = function(message, transfer) {
			attachInternalMessageListener(this, 'Worker.message', originalWorkerAddEventListener);
			trackTraffic('send', 'Worker.postMessage', 'Worker', message, 1);
			return originalWorkerPostMessage.apply(this, arguments);
		};
	}

	if(typeof SharedWorker !== 'undefined' && SharedWorker.prototype) {
		if(originalSharedWorkerSetter) {
			SharedWorker.prototype.__defineSetter__('onmessage', function(listener) {
				recordAssignedListener('SharedWorker.onmessage', 'SharedWorker', listener);
				originalSharedWorkerSetter.call(this, listener);
			});
		}

		if(originalSharedWorkerPostMessage) {
			SharedWorker.prototype.postMessage = function(message, transfer) {
				trackTraffic('send', 'SharedWorker.postMessage', 'SharedWorker', message, 1);
				return originalSharedWorkerPostMessage.apply(this, arguments);
			};
		}
	}

	if(NativeWebSocket) {
		var trackWebSocketListener = function(api, socket, listener) {
			recordAssignedListener(api, describeWebSocket(socket), listener);
			attachWebSocketInternalListeners(socket);
		};

		window.WebSocket = function(url, protocols) {
			var socket;
			if(arguments.length > 1) {
				socket = new NativeWebSocket(url, protocols);
			} else {
				socket = new NativeWebSocket(url);
			}
			websocketCounter++;
			socket.__postmessagetrackerid__ = websocketCounter;
			socket.__postmessagetrackerurl__ = String(url);
			attachWebSocketInternalListeners(socket);
			trackTraffic('send', 'WebSocket.construct', describeWebSocket(socket), '[connect]', 1, {
				url: String(url),
				protocols: typeof protocols == 'undefined' ? null : safeToString(protocols),
				readyState: socket.readyState
			});
			return socket;
		};
		window.WebSocket.prototype = NativeWebSocket.prototype;
		window.WebSocket.toString = function() {
			return originalFunctionToString.call(NativeWebSocket);
		};
		window.WebSocket.CONNECTING = NativeWebSocket.CONNECTING;
		window.WebSocket.OPEN = NativeWebSocket.OPEN;
		window.WebSocket.CLOSING = NativeWebSocket.CLOSING;
		window.WebSocket.CLOSED = NativeWebSocket.CLOSED;
		try {
			Object.setPrototypeOf(window.WebSocket, NativeWebSocket);
		} catch (e) {
		}

		NativeWebSocket.prototype.send = function(data) {
			attachWebSocketInternalListeners(this);
			trackTraffic('send', 'WebSocket.send', describeWebSocket(this), data, 1, {
				url: this.__postmessagetrackerurl__ || this.url || null,
				readyState: this.readyState
			});
			return originalWebSocketSend.apply(this, arguments);
		};

		NativeWebSocket.prototype.addEventListener = function(type, listener, useCapture) {
			if((type == 'message' || type == 'open' || type == 'close' || type == 'error') && typeof listener == 'function' && !listener.__postmessagetrackerinternal__) {
				trackWebSocketListener('WebSocket.addEventListener:' + type, this, listener);
			}
			return originalWebSocketAddEventListener.apply(this, arguments);
		};

		if(originalWebSocketMessageSetter) {
			NativeWebSocket.prototype.__defineSetter__('onmessage', function(listener) {
				trackWebSocketListener('WebSocket.onmessage', this, listener);
				originalWebSocketMessageSetter.call(this, listener);
			});
		}
		if(originalWebSocketOpenSetter) {
			NativeWebSocket.prototype.__defineSetter__('onopen', function(listener) {
				trackWebSocketListener('WebSocket.onopen', this, listener);
				originalWebSocketOpenSetter.call(this, listener);
			});
		}
		if(originalWebSocketCloseSetter) {
			NativeWebSocket.prototype.__defineSetter__('onclose', function(listener) {
				trackWebSocketListener('WebSocket.onclose', this, listener);
				originalWebSocketCloseSetter.call(this, listener);
			});
		}
		if(originalWebSocketErrorSetter) {
			NativeWebSocket.prototype.__defineSetter__('onerror', function(listener) {
				trackWebSocketListener('WebSocket.onerror', this, listener);
				originalWebSocketErrorSetter.call(this, listener);
			});
		}
	}

	Window.prototype.addEventListener = function(type, listener, useCapture) {
		if(type == 'message' && typeof listener == 'function' && !listener.__postmessagetrackerinternal__) {
			var pattern_before = false;
			var state = {offset: 0};
			if(listener.toString().indexOf('event.dispatch.apply') !== -1) {
				m({log: 'We got a jquery dispatcher'});
				pattern_before = /init\.on|init\..*on\]/;
				if(loaded) {
					setTimeout(j, 100);
				}
			}
			listener = unwrapWindowListener(listener, state);
			l(listener, pattern_before, state.offset, 'Window.addEventListener', 'window');
		}
		return msgeventlistener.apply(this, arguments);
	};

	window.addEventListener('load', j);
	window.addEventListener('postMessageTrackerUpdate', j);
})(
	History.prototype.pushState,
	Window.prototype.addEventListener,
	typeof MessagePort !== 'undefined' ? MessagePort.prototype.addEventListener : function() {}
);
