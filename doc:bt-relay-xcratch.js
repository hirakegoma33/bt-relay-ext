// bt-relay-xcratch.js - Bluetooth Relay (NUS) for Xcratch & TurboWarp
// Features: auto-reconnect, polling, send queue, multi-device memory & switching,
//           ON/OFF edge events, connected/disconnected events, bulk control by CSV
// NOTE: Requires a context where Web Bluetooth is available (HTTPS).
// For TurboWarp: open editor with ?unsandboxed and load as Text/File (unsandboxed).
(function (rootFactory) {
  // UMD-lite: register immediately if Scratch global exists; else export via ESM default if supported
  if (typeof Scratch !== 'undefined' && Scratch?.extensions) {
	Scratch.extensions.register(rootFactory(Scratch));
  } else if (typeof module !== 'undefined') {
	module.exports = rootFactory; // Node-like (not typical for browsers)
  } else {
	// Try to define as ESM default (Xcratch can import classic globals; this is just a fallback)
	try { export default rootFactory; } catch (_) {}
  }
})(function (Scratch) {
  'use strict';

  const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  const NUS_RX_CHAR = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // Write
  const NUS_TX_CHAR = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // Notify

  // Current "active" device context
  let device = null, server = null, rxChar = null, txChar = null;
  let connected = false;
  let connecting = false;
  let wantReconnect = false;
  let deviceName = '';
  let deviceId = '';

  // Known devices memory (id -> {id, name, device})
  const known = new Map();

  // State & errors
  let lastStateText = '';  // 'on'/'off' or '1'/'0'
  let lastStateNum = 0;    // 1/0
  let prevStateNum = 0;
  let lastError = '';

  // Edge flags for HAT events
  let edgeOn = false;
  let edgeOff = false;
  let edgeConnected = false;
  let edgeDisconnected = false;
  let prevConnected = false;

  // Auto-reconnect backoff
  let backoffMs = 1000;
  const backoffMax = 15000;
  let reconnectTimer = null;

  // Auto-poll
  let pollIntervalMs = 0;
  let pollTimer = null;

  // Send queue while disconnected
  const sendQueue = [];
  const QUEUE_MAX = 20;

  function setError(e) {
	lastError = (e && e.message) ? e.message : String(e || '');
  }
  function clearError() { lastError = ''; }

  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  function startPolling() {
	stopPolling();
	if (pollIntervalMs > 0 && connected) {
	  pollTimer = setInterval(() => { readState().catch(setError); }, pollIntervalMs);
	}
  }

  function stopReconnectTimer() { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } }
  function scheduleReconnect() {
	if (!wantReconnect) return;
	if (reconnectTimer) return;
	reconnectTimer = setTimeout(async () => {
	  reconnectTimer = null;
	  try { await reconnect(); }
	  catch (e) { setError(e); backoffMs = Math.min(backoffMs * 2, backoffMax); scheduleReconnect(); }
	}, backoffMs);
  }

  async function disconnectInternal({ forget = false } = {}) {
	try { if (device && device.gatt.connected) device.gatt.disconnect(); } catch (e) {}
	server = rxChar = txChar = null;
	if (connected) {
	  connected = false;
	  edgeDisconnected = true;
	  prevConnected = false;
	}
	connecting = false;
	stopPolling();
	if (forget && device) {
	  known.delete(device.id);
	  device = null;
	  deviceId = '';
	  deviceName = '';
	  prevStateNum = 0;
	  lastStateNum = 0;
	  lastStateText = '';
	}
  }

  async function onConnected() {
	connected = true;
	connecting = false;
	backoffMs = 1000;
	clearError();
	if (!prevConnected) {
	  edgeConnected = true;
	  prevConnected = true;
	}
	startPolling();
	// Drain queued sends
	while (sendQueue.length && connected) {
	  const s = sendQueue.shift();
	  try { await sendAscii(s); } catch (e) { setError(e); break; }
	}
  }

  async function setupGatt() {
	const service = await server.getPrimaryService(NUS_SERVICE);
	rxChar = await service.getCharacteristic(NUS_RX_CHAR);
	txChar = await service.getCharacteristic(NUS_TX_CHAR);
	await txChar.startNotifications();
	txChar.addEventListener('characteristicvaluechanged', (event) => {
	  const v = new TextDecoder().decode(event.target.value).trim();
	  updateStateFromText(v);
	});
  }

  function updateStateFromText(v) {
	lastStateText = v;
	const before = lastStateNum;
	if (v === 'on' || v === '1') lastStateNum = 1;
	else if (v === 'off' || v === '0') lastStateNum = 0;
	if (before === 0 && lastStateNum === 1) edgeOn = true;
	if (before === 1 && lastStateNum === 0) edgeOff = true;
	prevStateNum = lastStateNum;
  }

  async function requestAndConnect() {
	const dev = await navigator.bluetooth.requestDevice({
	  filters: [{ namePrefix: 'BT Relay' }, { namePrefix: 'BT' }],
	  optionalServices: [NUS_SERVICE]
	}).catch(async () => {
	  return await navigator.bluetooth.requestDevice({
		acceptAllDevices: true,
		optionalServices: [NUS_SERVICE]
	  });
	});
	attachDevice(dev);
	server = await device.gatt.connect();
	await setupGatt();
	await onConnected();
  }

  function attachDevice(dev) {
	device = dev;
	deviceName = device?.name || '';
	deviceId = device?.id || '';
	device.addEventListener('gattserverdisconnected', handleDisconnected);
	rememberDevice(device);
  }

  async function reconnect() {
	if (!device) throw new Error('以前に接続したデバイスがありません');
	if (connecting || (device.gatt && device.gatt.connected)) return;
	connecting = true;
	try {
	  server = await device.gatt.connect();
	  await setupGatt();
	  await onConnected();
	} finally {
	  connecting = false;
	}
  }

  function handleDisconnected() {
	if (connected) {
	  connected = false;
	  edgeDisconnected = true;
	  prevConnected = false;
	}
	stopPolling();
	if (wantReconnect) scheduleReconnect();
  }

  async function sendAscii(str) {
	if (!connected || !rxChar) {
	  if (wantReconnect) {
		if (sendQueue.length >= QUEUE_MAX) sendQueue.shift();
		sendQueue.push(str);
		scheduleReconnect();
		return;
	  }
	  throw new Error('未接続です');
	}
	const data = new TextEncoder().encode(str);
	await rxChar.writeValue(data);
  }

  async function readState() { await sendAscii('s'); }

  // Page lifecycle
  if (typeof document !== 'undefined') {
	document.addEventListener('visibilitychange', () => {
	  if (document.hidden) stopPolling(); else startPolling();
	});
  }
  if (typeof window !== 'undefined') {
	window.addEventListener('beforeunload', () => {
	  wantReconnect = false;
	  stopReconnectTimer();
	  stopPolling();
	  try { if (device && device.gatt.connected) device.gatt.disconnect(); } catch (e) {}
	});
  }

  // Known device helpers
  function rememberDevice(dev) { if (dev) known.set(dev.id, { id: dev.id, name: dev.name || '', device: dev }); }
  function findById(id) { return known.get(id)?.device || null; }
  function listIds()  { return Array.from(known.keys()); }
  function listNames(){ return Array.from(known.values()).map(v => v.name || ''); }

  async function connectSendById(id, action) {
	const dev = findById(id);
	if (!dev) throw new Error('未知のID: ' + id);
	if (!device || device.id !== dev.id) {
	  device = dev; deviceName = dev.name || ''; deviceId = dev.id || '';
	}
	if (!device.gatt.connected) {
	  server = await device.gatt.connect();
	  await setupGatt();
	  await onConnected();
	}
	switch (action) {
	  case 'ON':  await sendAscii('1'); break;
	  case 'OFF': await sendAscii('0'); break;
	  case 'TOGGLE': await sendAscii('t'); break;
	  case 'READ': default: await readState(); break;
	}
  }

  class BtRelayExtension {
	getInfo() {
	  return {
		id: 'btRelayNUS',
		name: 'Bluetooth Relay (NUS)',
		color1: '#0b82ff',
		color2: '#0b6ed6',
		blocks: [
		  // HAT events
		  { opcode: 'whenOn', blockType: Scratch.BlockType.HAT, text: '状態がONになったとき' },
		  { opcode: 'whenOff', blockType: Scratch.BlockType.HAT, text: '状態がOFFになったとき' },
		  { opcode: 'whenConnected', blockType: Scratch.BlockType.HAT, text: '接続されたとき' },
		  { opcode: 'whenDisconnected', blockType: Scratch.BlockType.HAT, text: '切断されたとき' },

		  // Connection
		  { opcode: 'btnConnect', blockType: Scratch.BlockType.BUTTON, text: 'Bluetoothに接続（スキャン）', func: 'btnConnect' },
		  { opcode: 'connectById', blockType: Scratch.BlockType.COMMAND, text: 'ID [id] で接続', arguments: {
			  id: { type: Scratch.ArgumentType.STRING, defaultValue: '' }
			}
		  },
		  { opcode: 'disconnect', blockType: Scratch.BlockType.COMMAND, text: '切断（記憶は保持）' },
		  { opcode: 'forgetCurrent', blockType: Scratch.BlockType.COMMAND, text: '切断して現在のデバイスを忘れる' },
		  { opcode: 'forgetById', blockType: Scratch.BlockType.COMMAND, text: 'ID [id] を忘れる', arguments: {
			  id: { type: Scratch.ArgumentType.STRING, defaultValue: '' }
			}
		  },
		  { opcode: 'forgetAll', blockType: Scratch.BlockType.COMMAND, text: 'すべての記憶デバイスを忘れる' },

		  { opcode: 'setReconnect', blockType: Scratch.BlockType.COMMAND, text: '自動再接続を [state] にする', arguments: {
			  state: { type: Scratch.ArgumentType.STRING, menu: 'onOff', defaultValue: 'オン' }
			}
		  },
		  { opcode: 'setPoll', blockType: Scratch.BlockType.COMMAND, text: 'ポーリング間隔を [ms] ms にする', arguments: {
			  ms: { type: Scratch.ArgumentType.NUMBER, defaultValue: 1000 }
			}
		  },

		  // Relay ops
		  { opcode: 'relayOn', blockType: Scratch.BlockType.COMMAND, text: 'リレーON' },
		  { opcode: 'relayOff', blockType: Scratch.BlockType.COMMAND, text: 'リレーOFF' },
		  { opcode: 'relayToggle', blockType: Scratch.BlockType.COMMAND, text: 'トグル' },
		  { opcode: 'readStateCmd', blockType: Scratch.BlockType.COMMAND, text: '状態を読む' },
		  { opcode: 'sendText', blockType: Scratch.BlockType.COMMAND, text: '文字列 [txt] を送信', arguments: {
			  txt: { type: Scratch.ArgumentType.STRING, defaultValue: 's' }
			}
		  },
		  { opcode: 'clearQueue', blockType: Scratch.BlockType.COMMAND, text: '送信キューをクリア' },

		  // Bulk ops
		  { opcode: 'bulkCsv', blockType: Scratch.BlockType.COMMAND, text: 'ID一覧（CSV）[csv] に [act] を送る', arguments: {
			  csv: { type: Scratch.ArgumentType.STRING, defaultValue: '' },
			  act: { type: Scratch.ArgumentType.STRING, menu: 'bulkAction', defaultValue: 'ON' }
			}
		  },

		  // Info
		  { opcode: 'stateNum', blockType: Scratch.BlockType.REPORTER, text: '状態（数字）' },
		  { opcode: 'stateText', blockType: Scratch.BlockType.REPORTER, text: '状態（文字）' },
		  { opcode: 'isConnected', blockType: Scratch.BlockType.BOOLEAN, text: '接続済み？' },
		  { opcode: 'getName', blockType: Scratch.BlockType.REPORTER, text: 'デバイス名' },
		  { opcode: 'getId', blockType: Scratch.BlockType.REPORTER, text: 'デバイスID' },
		  { opcode: 'getKnownIds', blockType: Scratch.BlockType.REPORTER, text: '記憶ID一覧（CSV）' },
		  { opcode: 'getKnownNames', blockType: Scratch.BlockType.REPORTER, text: '記憶名一覧（CSV）' },
		  { opcode: 'getError', blockType: Scratch.BlockType.REPORTER, text: '最終エラー' }
		],
		menus: {
		  onOff: { acceptReporters: true, items: ['オン', 'オフ'] },
		  bulkAction: { acceptReporters: true, items: ['ON', 'OFF', 'TOGGLE', 'READ'] }
		}
	  };
	}

	// HATs (edge-triggered)
	whenOn()            { if (edgeOn) { edgeOn = false; return true; } return false; }
	whenOff()           { if (edgeOff){ edgeOff= false; return true; } return false; }
	whenConnected()     { if (edgeConnected) { edgeConnected = false; return true; } return false; }
	whenDisconnected()  { if (edgeDisconnected){ edgeDisconnected = false; return true; } return false; }

	// Connection
	async btnConnect() {
	  clearError();
	  wantReconnect = true;
	  stopReconnectTimer();
	  try { await requestAndConnect(); }
	  catch (e) { setError(e); scheduleReconnect(); throw e; }
	}
	async connectById(args) {
	  clearError();
	  wantReconnect = true;
	  stopReconnectTimer();
	  const id = String(args.id || '').trim();
	  try {
		const dev = findById(id);
		if (!dev) { await requestAndConnect(); return; }
		device = dev; deviceName = device.name || ''; deviceId = device.id || '';
		await reconnect();
	  } catch (e) {
		setError(e);
		try { await requestAndConnect(); } catch (ee) { setError(ee); throw ee; }
	  }
	}
	async disconnect()         { wantReconnect = false; stopReconnectTimer(); await disconnectInternal({ forget: false }); }
	async forgetCurrent()      { wantReconnect = false; stopReconnectTimer(); await disconnectInternal({ forget: true  }); }
	async forgetById(args)     {
	  const id = String(args.id || '').trim();
	  if (device && device.id === id) await this.forgetCurrent(); else known.delete(id);
	}
	async forgetAll()          { wantReconnect = false; stopReconnectTimer(); await disconnectInternal({ forget: true }); known.clear(); }
	setReconnect(args)         {
	  const on = (String(args.state) === 'オン');
	  wantReconnect = on;
	  if (on && !connected) scheduleReconnect();
	  if (!on) stopReconnectTimer();
	}
	setPoll(args)              {
	  const v = Math.max(0, Math.floor(Number(args.ms) || 0));
	  pollIntervalMs = v;
	  if (connected) startPolling();
	}

	// Relay ops
	async relayOn()      { try { await sendAscii('1'); } catch (e) { setError(e); throw e; } }
	async relayOff()     { try { await sendAscii('0'); } catch (e) { setError(e); throw e; } }
	async relayToggle()  { try { await sendAscii('t'); } catch (e) { setError(e); throw e; } }
	async readStateCmd() { try { await readState(); }  catch (e) { setError(e); throw e; } }
	async sendText(args) { try { await sendAscii(String(args.txt ?? '')); } catch (e) { setError(e); throw e; } }
	clearQueue()         { sendQueue.length = 0; }

	// Bulk ops
	async bulkCsv(args) {
	  clearError();
	  const csv = String(args.csv || '').trim();
	  const act = String(args.act || 'ON').toUpperCase();
	  if (!csv) return;
	  const ids = csv.split(',').map(s => s.trim()).filter(Boolean);
	  for (const id of ids) {
		try { await connectSendById(id, act); }
		catch (e) { setError(`ID ${id}: ${e.message || e}`); }
	  }
	}

	// Info
	stateNum()       { return String(lastStateNum); }
	stateText()      { return lastStateText; }
	isConnected()    { return connected; }
	getName()        { return deviceName; }
	getId()          { return deviceId; }
	getKnownIds()    { return listIds().join(','); }
	getKnownNames()  { return listNames().join(','); }
	getError()       { return lastError; }
  }

  return new BtRelayExtension();
});
