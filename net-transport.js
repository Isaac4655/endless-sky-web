// net-transport.js
//
// Browser-main-thread WebRTC bridge for Endless Sky's host-as-server
// multiplayer (v1). This file is loaded as a plain <script> in index.html,
// runs entirely on the page's real main thread (never inside the
// PROXY_TO_PTHREAD application worker), and talks to the C++ side only
// through the three Module._esNetTransport... exports defined in
// source/net/NetTransport.cpp.
//
// v1 signaling is manual copy/paste of SDP text (see the plan's open
// question about signaling approach): StartHosting produces an SDP offer
// that the host shares with a guest out of band (a chat link, Discord
// message, whatever); the guest pastes it in, which produces an SDP answer
// that the host pastes back. This keeps v1 free of any external signaling
// server. A future version can swap this file's internals for a WebSocket
// relay without touching the C++ side at all, since the C++/JS boundary is
// just "local description became available" / "remote description arrived."
//
// Connection state numbering must match NetTransport::ConnectionState in
// source/net/NetTransport.h exactly.
const ES_NET_STATE_DISCONNECTED = 0;
const ES_NET_STATE_SIGNALING = 1;
const ES_NET_STATE_CONNECTED = 2;
const ES_NET_STATE_FAILED = 3;

(function()
{
	let peerConnection = null;
	let dataChannel = null;
	let isHost = false;

	// Endless Sky ships no TURN server of its own; these are Google's public
	// STUN servers, used only to discover each peer's public address for the
	// (very common) case where both sides are behind a simple NAT. Two
	// players behind symmetric NATs/strict firewalls will fail to connect in
	// v1 without a TURN relay - called out explicitly rather than silently
	// failing, see onConnectionStateChange below.
	const RTC_CONFIG = {
		iceServers: [
			{ urls: "stun:stun.l.google.com:19302" },
			{ urls: "stun:stun1.l.google.com:19302" },
		],
	};

	function reportState(state, detail)
	{
		if(typeof Module === "undefined" || !Module._esNetTransportOnStateChange)
			return;
		try
		{
			const detailPtr = allocateUTF8(detail || "");
			Module._esNetTransportOnStateChange(state, detailPtr);
			Module._free(detailPtr);
		}
		catch(error)
		{
			console.error("[Net] reportState failed - allocateUTF8/_malloc/_free may not be exported:", error);
		}
	}

	function reportLocalDescription(sdpText)
	{
		if(typeof Module === "undefined" || !Module._esNetTransportOnLocalDescription)
			return;
		// NOTE: allocateUTF8 (and reportState/reportMessage's use of
		// Module._malloc/HEAPU8/Module.HEAPU8) are Emscripten runtime
		// helpers that must be present in the build's
		// -sEXPORTED_RUNTIME_METHODS list (and, for _malloc/_free, in
		// -sEXPORTED_FUNCTIONS) to exist on `Module` at all. This project's
		// Emscripten link flags live in a CMake file that wasn't available
		// when this was written, so this call could silently do nothing
		// (or throw, caught below) if allocateUTF8 isn't exported - if the
		// connection code still never appears after the
		// onicegatheringstatechange fix, check the browser devtools
		// console for a ReferenceError here as the next thing to rule out.
		try
		{
			const sdpPtr = allocateUTF8(sdpText);
			Module._esNetTransportOnLocalDescription(sdpPtr);
			Module._free(sdpPtr);
		}
		catch(error)
		{
			console.error("[Net] reportLocalDescription failed - allocateUTF8/_malloc/_free may not be exported:", error);
		}
	}

	function reportMessage(bytes)
	{
		if(typeof Module === "undefined" || !Module._esNetTransportOnMessage)
			return;
		try
		{
			const ptr = Module._malloc(bytes.byteLength);
			Module.HEAPU8.set(new Uint8Array(bytes), ptr);
			Module._esNetTransportOnMessage(ptr, bytes.byteLength);
			Module._free(ptr);
		}
		catch(error)
		{
			console.error("[Net] reportMessage failed - _malloc/_free may not be exported:", error);
		}
	}

	function wireDataChannel(channel)
	{
		channel.binaryType = "arraybuffer";
		channel.onopen = function()
		{
			reportState(ES_NET_STATE_CONNECTED, "");
		};
		channel.onclose = function()
		{
			reportState(ES_NET_STATE_DISCONNECTED, "data channel closed");
		};
		channel.onerror = function(event)
		{
			reportState(ES_NET_STATE_FAILED, "data channel error: " + (event && event.message ? event.message : "unknown"));
		};
		channel.onmessage = function(event)
		{
			// We only ever send ArrayBuffers (see send() below), so a string
			// message here would indicate a protocol bug on one side.
			if(event.data instanceof ArrayBuffer)
				reportMessage(event.data);
			else
				console.warn("[Net] Ignoring non-binary data channel message.");
		};
	}

	function wirePeerConnection(connection)
	{
		// Using the "wait for ICE gathering to complete, then use the
		// single consolidated description" approach (simpler for manual
		// copy/paste signaling than trickling individual candidates one at
		// a time) rather than streaming each candidate separately.
		//
		// IMPORTANT: this must be driven by onicegatheringstatechange, NOT
		// by checking connection.iceGatheringState inside onicecandidate.
		// onicecandidate only fires when a candidate is found; there is no
		// guarantee it fires again (or fires at all) at the exact moment
		// gathering state flips to "complete" - that transition is reported
		// separately and asynchronously via its own event. Relying on
		// onicecandidate here was the bug: gathering would complete but
		// nothing ever noticed, so no local description was ever reported
		// and the "still generating your connection code" message never
		// went away no matter how long you waited or how many times you
		// retried.
		connection.onicegatheringstatechange = function()
		{
			if(connection.iceGatheringState === "complete")
				reportLocalDescription(JSON.stringify(connection.localDescription));
		};
		connection.onconnectionstatechange = function()
		{
			if(connection.connectionState === "failed" || connection.connectionState === "closed")
				reportState(ES_NET_STATE_FAILED,
					"WebRTC connection " + connection.connectionState +
					" (if both peers are behind restrictive NATs, a TURN relay would be needed; v1 has none configured)");
		};
	}

	self.__esNetTransport = {
		startHosting: function()
		{
			isHost = true;
			reportState(ES_NET_STATE_SIGNALING, "");
			peerConnection = new RTCPeerConnection(RTC_CONFIG);
			wirePeerConnection(peerConnection);

			dataChannel = peerConnection.createDataChannel("endless-sky-net", { ordered: true });
			wireDataChannel(dataChannel);

			peerConnection.createOffer()
				.then(function(offer) { return peerConnection.setLocalDescription(offer); })
				.catch(function(error)
				{
					reportState(ES_NET_STATE_FAILED, "createOffer failed: " + error);
				});
			// reportLocalDescription fires from onicegatheringstatechange
			// once ICE gathering completes, carrying the full offer +
			// candidates as one JSON blob for the host to hand to the guest.
		},

		joinHost: function(offerText)
		{
			isHost = false;
			reportState(ES_NET_STATE_SIGNALING, "");
			let offer;
			try
			{
				offer = JSON.parse(offerText);
			}
			catch(error)
			{
				reportState(ES_NET_STATE_FAILED, "Could not parse host's connection code: " + error);
				return;
			}

			peerConnection = new RTCPeerConnection(RTC_CONFIG);
			wirePeerConnection(peerConnection);
			// The guest receives the data channel the host created, rather
			// than creating its own, since createDataChannel was called
			// host-side above.
			peerConnection.ondatachannel = function(event)
			{
				dataChannel = event.channel;
				wireDataChannel(dataChannel);
			};

			peerConnection.setRemoteDescription(new RTCSessionDescription(offer))
				.then(function() { return peerConnection.createAnswer(); })
				.then(function(answer) { return peerConnection.setLocalDescription(answer); })
				.catch(function(error)
				{
					reportState(ES_NET_STATE_FAILED, "Failed to join host: " + error);
				});
			// reportLocalDescription fires once ICE gathering completes,
			// carrying the answer the player pastes back to the host.
		},

		acceptRemoteDescription: function(descriptionText)
		{
			if(!peerConnection)
			{
				reportState(ES_NET_STATE_FAILED, "No connection in progress to accept a description for.");
				return;
			}
			let description;
			try
			{
				description = JSON.parse(descriptionText);
			}
			catch(error)
			{
				reportState(ES_NET_STATE_FAILED, "Could not parse connection code: " + error);
				return;
			}
			// Only the host still needs to accept a remote description after
			// startup (the guest's answer); the guest supplied its remote
			// description already in joinHost.
			peerConnection.setRemoteDescription(new RTCSessionDescription(description))
				.catch(function(error)
				{
					reportState(ES_NET_STATE_FAILED, "Failed to accept guest's answer: " + error);
				});
		},

		send: function(bytes)
		{
			if(!dataChannel || dataChannel.readyState !== "open")
				return;
			dataChannel.send(bytes);
		},
	};
})();