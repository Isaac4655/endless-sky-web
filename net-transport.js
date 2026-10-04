// net-transport.js
//
// Browser-main-thread WebRTC bridge for Endless Sky multiplayer.
//
// This version is completely serverless. Signaling is user-mediated: the host
// generates a compressed connection code, the guest pastes it, the guest then
// generates a compressed reply code, and the host pastes that reply back.
//
// The connection code contains only compressed WebRTC negotiation data. It uses
// a URL-safe base64 alphabet (A-Z, a-z, 0-9, '-' and '_') with no whitespace,
// so it can be copied as one uninterrupted string with the game's normal
// Ctrl+C / Ctrl+V clipboard handling.

const ES_NET_STATE_DISCONNECTED = 0;
const ES_NET_STATE_SIGNALING = 1;
const ES_NET_STATE_CONNECTED = 2;
const ES_NET_STATE_FAILED = 3;

(function()
{
	let peerConnection = null;
	let dataChannel = null;
	let isHost = false;

	// Fully self-contained WebRTC configuration. We intentionally do not use a
	// public STUN or TURN server here: all negotiation data is carried inside the
	// user-mediated connection codes. Without STUN/TURN, Internet connections
	// between peers behind NAT may not be possible; direct/LAN connections and
	// environments with directly reachable ICE candidates still work.
	const RTC_CONFIG = {
		iceServers: [],
	};

	const CODE_VERSION = 1;
	const TYPE_OFFER = 0;
	const TYPE_ANSWER = 1;

	function allocateUTF8Manual(text)
	{
		const encoded = new TextEncoder().encode(text);
		const ptr = Module._esNetTransportAlloc(encoded.length + 1);
		if(!ptr)
			throw new Error("esNetTransportAlloc failed");

		Module.HEAPU8.set(encoded, ptr);
		Module.HEAPU8[ptr + encoded.length] = 0;
		return ptr;
	}

	function reportState(state, detail)
	{
		if(typeof Module === "undefined" || !Module._esNetTransportOnStateChange)
			return;
		try
		{
			const detailPtr = allocateUTF8Manual(detail || "");
			Module._esNetTransportOnStateChange(state, detailPtr);
			Module._esNetTransportFree(detailPtr);
		}
		catch(error)
		{
			console.error("[Net] reportState failed:", error);
		}
	}

	function reportLocalDescription(text)
	{
		if(typeof Module === "undefined" || !Module._esNetTransportOnLocalDescription)
			return;
		try
		{
			const textPtr = allocateUTF8Manual(text);
			Module._esNetTransportOnLocalDescription(textPtr);
			Module._esNetTransportFree(textPtr);
		}
		catch(error)
		{
			console.error("[Net] reportLocalDescription failed:", error);
		}
	}

	function reportMessage(bytes)
	{
		if(typeof Module === "undefined" || !Module._esNetTransportOnMessage)
			return;
		try
		{
			const ptr = Module._esNetTransportAlloc(bytes.byteLength);
			if(!ptr)
				throw new Error("esNetTransportAlloc failed");
			Module.HEAPU8.set(new Uint8Array(bytes), ptr);
			Module._esNetTransportOnMessage(ptr, bytes.byteLength);
			Module._esNetTransportFree(ptr);
		}
		catch(error)
		{
			console.error("[Net] reportMessage failed:", error);
		}
	}

	function normalizeConnectionCode(code)
	{
		return String(code || "").replace(/\s+/g, "");
	}

	function base64UrlEncode(bytes)
	{
		let binary = "";
		const chunkSize = 0x8000;
		for(let offset = 0; offset < bytes.length; offset += chunkSize)
		{
			const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
			binary += String.fromCharCode(...chunk);
		}
		return btoa(binary)
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/g, "");
	}

	function base64UrlDecode(text)
	{
		const normalized = normalizeConnectionCode(text)
			.replace(/-/g, "+")
			.replace(/_/g, "/");
		if(!normalized.length)
			throw new Error("The connection code is empty.");

		if(!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized))
			throw new Error("The connection code contains invalid characters.");

		const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
		let binary;
		try
		{
			binary = atob(padded);
		}
		catch(error)
		{
			throw new Error("The connection code is not valid base64 data.");
		}

		const bytes = new Uint8Array(binary.length);
		for(let i = 0; i < binary.length; ++i)
			bytes[i] = binary.charCodeAt(i);
		return bytes;
	}

	async function compressBytes(bytes)
	{
		if(typeof CompressionStream === "undefined")
			throw new Error("This browser does not support the built-in connection-code compressor.");

		const compressor = new CompressionStream("gzip");
		const writer = compressor.writable.getWriter();
		await writer.write(bytes);
		await writer.close();
		return new Uint8Array(await new Response(compressor.readable).arrayBuffer());
	}

	async function decompressBytes(bytes)
	{
		if(typeof DecompressionStream === "undefined")
			throw new Error("This browser does not support the built-in connection-code decompressor.");

		const decompressor = new DecompressionStream("gzip");
		const writer = decompressor.writable.getWriter();
		await writer.write(bytes);
		await writer.close();
		return new Uint8Array(await new Response(decompressor.readable).arrayBuffer());
	}

	async function encodeConnectionCode(description)
	{
		if(!description || typeof description.sdp !== "string" || !description.sdp.length)
			throw new Error("WebRTC did not produce a usable connection description.");

		const sdpBytes = new TextEncoder().encode(description.sdp);
		const typeByte = description.type === "offer" ? TYPE_OFFER :
			description.type === "answer" ? TYPE_ANSWER : -1;
		if(typeByte < 0)
			throw new Error("WebRTC produced an unsupported description type.");

		// Tiny binary envelope before compression:
		//   byte 0: connection-code format version
		//   byte 1: 0 = offer, 1 = answer
		//   bytes 2+: UTF-8 SDP text
		const payload = new Uint8Array(2 + sdpBytes.length);
		payload[0] = CODE_VERSION;
		payload[1] = typeByte;
		payload.set(sdpBytes, 2);

		const compressed = await compressBytes(payload);
		return base64UrlEncode(compressed);
	}

	async function decodeConnectionCode(codeText)
	{
		const compressed = base64UrlDecode(codeText);
		const payload = await decompressBytes(compressed);
		if(payload.length < 3)
			throw new Error("The connection code is too short.");
		if(payload[0] !== CODE_VERSION)
			throw new Error("The connection code uses an unsupported version.");

		let type;
		if(payload[1] === TYPE_OFFER)
			type = "offer";
		else if(payload[1] === TYPE_ANSWER)
			type = "answer";
		else
			throw new Error("The connection code contains an invalid description type.");

		const sdp = new TextDecoder().decode(payload.subarray(2));
		if(!sdp.startsWith("v=0\r\n") && !sdp.startsWith("v=0\n"))
			throw new Error("The connection code does not contain valid SDP.");

		return {type, sdp};
	}

	async function publishLocalDescription(description)
	{
		try
		{
			const code = await encodeConnectionCode(description);
			reportLocalDescription(code);
			console.log("[Net] Generated " + description.type + " connection code (" + code.length + " characters).");
		}
		catch(error)
		{
			reportState(ES_NET_STATE_FAILED, "Could not generate the connection code: " + error.message);
			console.error("[Net] Connection-code generation failed:", error);
		}
	}

	function waitForIceGatheringComplete(connection)
	{
		if(connection.iceGatheringState === "complete")
			return Promise.resolve();

		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = () => {
				if(settled)
					return;
				settled = true;
				clearTimeout(timer);
				connection.removeEventListener("icegatheringstatechange", checkState);
				connection.removeEventListener("icecandidate", checkCandidate);
				resolve();
			};
			const fail = error => {
				if(settled)
					return;
				settled = true;
				clearTimeout(timer);
				connection.removeEventListener("icegatheringstatechange", checkState);
				connection.removeEventListener("icecandidate", checkCandidate);
				reject(error);
			};
			const checkState = () => {
				if(connection.iceGatheringState === "complete")
					finish();
			};
			const checkCandidate = event => {
				if(event.candidate === null)
					checkState();
			};
			const timer = setTimeout(() => fail(new Error("ICE gathering timed out.")), 30000);

			connection.addEventListener("icegatheringstatechange", checkState);
			connection.addEventListener("icecandidate", checkCandidate);
			checkState();
		});
	}

	function closePeerConnection()
	{
		if(dataChannel)
		{
			try { dataChannel.close(); }
			catch(error) {}
			dataChannel = null;
		}
		if(peerConnection)
		{
			try { peerConnection.close(); }
			catch(error) {}
			peerConnection = null;
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
			reportState(ES_NET_STATE_FAILED,
				"WebRTC data channel error: " + (event && event.message ? event.message : "unknown"));
		};
		channel.onmessage = function(event)
		{
			if(event.data instanceof ArrayBuffer)
				reportMessage(event.data);
			else
				console.warn("[Net] Ignoring non-binary data channel message.");
		};
	}

	function wirePeerConnection(connection)
	{
		connection.onconnectionstatechange = function()
		{
			if(connection.connectionState === "failed")
				reportState(ES_NET_STATE_FAILED,
					"WebRTC connection failed. Direct browser-to-browser networking may be unavailable between these networks without a STUN/TURN service.");
			else if(connection.connectionState === "closed")
				reportState(ES_NET_STATE_DISCONNECTED, "WebRTC connection closed");
		};
	}

	self.__esNetTransport = {
		startHosting: async function()
		{
			isHost = true;
			closePeerConnection();
			reportState(ES_NET_STATE_SIGNALING, "");

			try
			{
				peerConnection = new RTCPeerConnection(RTC_CONFIG);
				wirePeerConnection(peerConnection);

				dataChannel = peerConnection.createDataChannel("endless-sky-net", {ordered: true});
				wireDataChannel(dataChannel);

				const offer = await peerConnection.createOffer();
				await peerConnection.setLocalDescription(offer);
				await waitForIceGatheringComplete(peerConnection);
				await publishLocalDescription(peerConnection.localDescription);
			}
			catch(error)
			{
				reportState(ES_NET_STATE_FAILED, "Could not create a multiplayer connection code: " + error.message);
				console.error("[Net] Host setup failed:", error);
			}
		},

		joinHost: async function(codeText)
		{
			isHost = false;
			closePeerConnection();
			reportState(ES_NET_STATE_SIGNALING, "");

			try
			{
				const offer = await decodeConnectionCode(codeText);
				if(offer.type !== "offer")
					throw new Error("This is not a host connection code.");

				peerConnection = new RTCPeerConnection(RTC_CONFIG);
				wirePeerConnection(peerConnection);
				peerConnection.ondatachannel = function(event)
				{
					dataChannel = event.channel;
					wireDataChannel(dataChannel);
				};

				await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
				const answer = await peerConnection.createAnswer();
				await peerConnection.setLocalDescription(answer);
				await waitForIceGatheringComplete(peerConnection);
				await publishLocalDescription(peerConnection.localDescription);
			}
			catch(error)
			{
				reportState(ES_NET_STATE_FAILED, "Failed to use the host connection code: " + error.message);
				console.error("[Net] Guest setup failed:", error);
			}
		},

		acceptRemoteDescription: async function(codeText)
		{
			if(!peerConnection)
			{
				reportState(ES_NET_STATE_FAILED, "No multiplayer connection is waiting for a reply code.");
				return;
			}

			try
			{
				const answer = await decodeConnectionCode(codeText);
				if(answer.type !== "answer")
					throw new Error("This is not a guest reply code.");

				await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
			}
			catch(error)
			{
				reportState(ES_NET_STATE_FAILED, "Could not accept the guest connection code: " + error.message);
				console.error("[Net] Remote connection-code decode failed:", error);
			}
		},

		send: function(bytes)
		{
			if(!dataChannel || dataChannel.readyState !== "open")
				return;
			dataChannel.send(bytes);
		},
	};
})();
