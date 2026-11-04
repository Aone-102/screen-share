(() => {
  'use strict';

  const MAX_ROOM_SIZE = 10;
  const ROOM_RE = /^[A-Z0-9]{3,16}$/;
  const PEER_DEBUG = 1;
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:3478' },
    ],
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    landing: $('landing'),
    joinForm: $('join-form'),
    nameInput: $('name-input'),
    roomInput: $('room-input'),
    landingHint: $('landing-hint'),
    roomView: $('room-view'),
    roomCode: $('room-code'),
    peerCount: $('peer-count'),
    maxRoom: $('max-room'),
    leave: $('leave'),
    connBanner: $('conn-banner'),
    secureBanner: $('secure-banner'),
    localPreview: $('local-preview'),
    localVideo: $('local-video'),
    localPlaceholder: $('local-placeholder'),
    localBadge: $('local-badge'),
    shareStatus: $('share-status'),
    shareScreen: $('share-screen'),
    shareCamera: $('share-camera'),
    shareStop: $('share-stop'),
    micToggle: $('mic-toggle'),
    shareHint: $('share-hint'),
    grid: $('grid'),
    empty: $('empty'),
    toast: $('toast'),
  };

  const state = {
    peer: null,
    role: null,
    selfId: null,
    hostId: null,
    hostName: '방장',
    room: '',
    name: '',
    joined: false,
    joining: false,
    leaving: false,
    peers: new Map(),
    guestConns: new Map(),
    hostConn: null,
    localStream: null,
    localMode: null,
    micMuted: false,
    joinToken: 0,
  };

  let canScreenShare = false;
  let startingShare = false;
  let toastTimer = null;
  let reconnectTimer = null;
  let joinAnswerTimer = null;

  /* ── 공통 UI ───────────────────────────────── */
  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 3400);
  }

  function setBanner(message) {
    els.connBanner.textContent = message;
    els.connBanner.classList.remove('hidden');
  }

  function hideBanner() {
    els.connBanner.classList.add('hidden');
  }

  function configureSecureBanner() {
    els.secureBanner.classList.toggle('hidden', Boolean(window.isSecureContext));
  }

  function updateCount() {
    const count = state.joined ? state.peers.size + 1 : 1;
    els.peerCount.textContent = `${count}명`;
    els.empty.classList.toggle('hidden', state.peers.size > 0);
  }

  function updateEmpty() {
    els.empty.classList.toggle('hidden', state.peers.size > 0);
  }

  function refreshShareUI() {
    const sharing = Boolean(state.localStream);
    const hasAudio = Boolean(state.localStream?.getAudioTracks().length);

    els.shareScreen.classList.toggle('hidden', !canScreenShare);
    els.shareScreen.disabled = !state.joined || sharing;
    els.shareCamera.disabled = !state.joined || sharing;
    els.shareStop.classList.toggle('hidden', !sharing);
    els.micToggle.disabled = !hasAudio;
    els.micToggle.classList.toggle('is-off', state.micMuted);
    els.micToggle.textContent = state.micMuted ? '🔇 마이크 꺼짐' : '🎤 마이크 켜짐';

    els.localPreview.classList.toggle('sharing', sharing);
    els.localBadge.classList.toggle('hidden', !sharing);
    if (sharing) {
      els.localBadge.textContent = state.localMode === 'camera' ? '카메라 공유 중' : '화면 공유 중';
      els.shareStatus.textContent = hasAudio
        ? '공유 중입니다. 마이크도 함께 전송됩니다.'
        : '공유 중입니다. (마이크 권한이 없어 소리는 전송되지 않습니다)';
    } else if (!state.joined) {
      els.shareStatus.textContent = '방에 연결하는 중입니다…';
    } else {
      els.shareStatus.textContent = canScreenShare
        ? '화면 또는 카메라를 공유할 수 있습니다.'
        : '카메라를 공유할 수 있습니다.';
    }

    if (!window.isSecureContext) {
      els.shareHint.textContent = '보안 연결(HTTPS)에서만 화면·카메라 공유가 가능합니다.';
    } else if (!navigator.mediaDevices) {
      els.shareHint.textContent = '이 브라우저에서는 미디어 공유를 지원하지 않습니다.';
    } else if (!canScreenShare) {
      els.shareHint.textContent = '휴대폰 브라우저는 화면 전체 공유를 지원하지 않아 카메라로 참여합니다.';
    } else {
      els.shareHint.textContent = '화면을 공유하면 선택한 화면이 모든 참가자에게 보입니다.';
    }
  }

  function hostIdFor(room) {
    return `ss-${room}-host`;
  }

  function guestIdFor(room) {
    const suffix = window.crypto?.randomUUID
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
    return `ss-${room}-${suffix}`;
  }

  function safeName(value) {
    const name = String(value || '').trim().slice(0, 20);
    return name || '익명';
  }

  function safeSend(conn, message) {
    if (!conn?.open) return false;
    try {
      conn.send(message);
      return true;
    } catch (err) {
      console.warn('메시지 전송 실패', err);
      return false;
    }
  }

  function sendToHost(message) {
    return safeSend(state.hostConn, message);
  }

  function broadcastToGuests(message, exceptId) {
    for (const [id, conn] of state.guestConns) {
      if (id === exceptId) continue;
      safeSend(conn, message);
    }
  }

  function describePeerError(err) {
    const type = err?.type || '';
    if (type === 'peer-unavailable') {
      return '방을 찾을 수 없습니다. 방 코드를 확인하거나 방장이 입장했는지 확인해 주세요.';
    }
    if (
      type === 'network' ||
      type === 'server-error' ||
      type === 'socket-error' ||
      type === 'socket-closed' ||
      type === 'ssl-unavailable'
    ) {
      return 'PeerJS 신호 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.';
    }
    if (type === 'browser-incompatible') {
      return '이 브라우저에서는 화상 연결을 지원하지 않습니다.';
    }
    if (type === 'unavailable-id') {
      return '이미 사용 중인 연결입니다. 다시 시도해 주세요.';
    }
    return err?.message || '방에 입장하지 못했습니다.';
  }

  /* ── 공유 UI ───────────────────────────────── */
  function setLocalStream(stream, mode) {
    state.localStream = stream;
    state.localMode = mode;
    state.micMuted = false;

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) videoTrack.addEventListener('ended', onLocalTrackEnded, { once: true });

    els.localVideo.srcObject = stream;
    els.localVideo.muted = true;
    els.localVideo.classList.toggle('mirrored', mode === 'camera');
    els.localVideo.play().catch(() => {});

    if (state.joined) {
      callAllPeers();
      announceShare();
    }
    refreshShareUI();
  }

  function onLocalTrackEnded() {
    stopSharing({ silent: false, notify: true });
  }

  function stopSharing({ silent = false, notify = true } = {}) {
    const stream = state.localStream;
    if (!stream) return;
    state.localStream = null;
    state.localMode = null;
    state.micMuted = false;

    closeOutgoingCalls();
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    }
    els.localVideo.srcObject = null;
    els.localVideo.classList.remove('mirrored');

    if (state.joined && notify) announceShare();
    refreshShareUI();
    if (!silent) showToast('공유를 중지했습니다.');
  }

  function toggleMic() {
    if (!state.localStream?.getAudioTracks().length) {
      showToast('마이크가 연결되어 있지 않습니다.');
      return;
    }
    state.micMuted = !state.micMuted;
    for (const track of state.localStream.getAudioTracks()) track.enabled = !state.micMuted;
    refreshShareUI();
  }

  async function captureStream(mode) {
    if (!navigator.mediaDevices) {
      throw new DOMException('미디어 장치를 사용할 수 없습니다.', 'NotSupportedError');
    }
    if (mode === 'screen') {
      if (typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
        throw new DOMException(
          '이 기기에서는 화면 공유를 지원하지 않습니다. 카메라를 사용해 주세요.',
          'NotSupportedError',
        );
      }
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      let mic = null;
      try {
        mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch {
        mic = null;
      }
      const tracks = [...display.getVideoTracks(), ...(mic ? mic.getAudioTracks() : [])];
      const stream = new MediaStream(tracks);
      const video = display.getVideoTracks()[0];
      if (video) {
        video.addEventListener('ended', () => {
          for (const track of mic?.getAudioTracks() || []) track.stop();
        });
      }
      return stream;
    }
    return navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  }

  async function startSharing(mode) {
    if (startingShare || state.localStream) return;
    if (!state.joined) {
      showToast('방에 연결 중입니다. 잠시만 기다려 주세요.');
      return;
    }
    if (!window.isSecureContext) {
      showToast('HTTPS 주소에서만 화면·카메라 공유가 가능합니다.');
      return;
    }
    startingShare = true;
    els.shareStatus.textContent =
      mode === 'screen' ? '공유할 화면을 선택하세요…' : '카메라 권한을 기다리는 중…';
    try {
      const stream = await captureStream(mode);
      if (!stream.getVideoTracks().length) {
        throw new DOMException('공유할 영상이 없습니다.', 'NotFoundError');
      }
      setLocalStream(stream, mode);
    } catch (err) {
      console.warn(err);
      if (err?.name === 'NotAllowedError') {
        showToast('공유가 취소되었거나 권한이 거부되었습니다.');
      } else if (err?.name === 'NotFoundError') {
        showToast('사용할 수 있는 카메라/화면을 찾지 못했습니다.');
      } else if (err?.name === 'NotReadableError') {
        showToast('다른 앱에서 카메라를 사용 중일 수 있습니다.');
      } else {
        showToast(err?.message || '공유를 시작하지 못했습니다.');
      }
    } finally {
      startingShare = false;
      refreshShareUI();
    }
  }

  /* ── 참가자 타일 ───────────────────────────── */
  function createTile(peer) {
    const tile = document.createElement('article');
    tile.className = 'tile';
    tile.innerHTML = `
      <div class="tile-video">
        <video autoplay playsinline webkit-playsinline></video>
        <div class="tile-placeholder">
          <div class="avatar"></div>
          <span class="placeholder-text">아직 공유하지 않음</span>
        </div>
        <span class="badge hidden"></span>
        <button type="button" class="play-overlay hidden">🔊 소리 켜기</button>
      </div>
      <div class="tile-bar">
        <span class="tile-name"></span>
        <span class="conn-dot" data-state="new" title="연결 대기"></span>
      </div>`;

    const video = tile.querySelector('video');
    video.srcObject = peer.stream;
    tile.querySelector('.play-overlay').addEventListener('click', () => {
      video
        .play()
        .then(() => tile.classList.remove('needs-play'))
        .catch(() => showToast('재생을 시작할 수 없습니다. 화면을 다시 눌러 주세요.'));
    });
    return tile;
  }

  function setConnState(peer, connState) {
    if (!peer?.tile) return;
    peer.connState = connState;
    const dot = peer.tile.querySelector('.conn-dot');
    dot.dataset.state = connState;
    const labels = {
      new: '연결 대기',
      connecting: '연결 중',
      connected: '연결됨',
      disconnected: '연결 끊김',
      failed: '연결 실패',
      closed: '종료됨',
    };
    dot.title = labels[connState] || connState;
  }

  function renderPeer(peer) {
    const tile = peer?.tile;
    if (!tile) return;
    const sharing = Boolean(peer.sharing);
    tile.classList.toggle('sharing', sharing);
    tile.querySelector('.tile-name').textContent = peer.name;
    tile.querySelector('.avatar').textContent = (peer.name || '?').slice(0, 1);
    tile.querySelector('.placeholder-text').textContent = peer.pending
      ? '영상 연결 중…'
      : sharing
        ? '공유 중'
        : '아직 공유하지 않음';

    const badge = tile.querySelector('.badge');
    badge.textContent = peer.mode === 'camera' ? '카메라' : '화면 공유';
    badge.classList.toggle('hidden', !(sharing || peer.pending));

    if (sharing) {
      const video = tile.querySelector('video');
      video.play().then(
        () => tile.classList.remove('needs-play'),
        () => tile.classList.add('needs-play'),
      );
    }
    setConnState(peer, peer.connState || 'connected');
  }

  function ensurePeer(meta) {
    if (!meta?.id || meta.id === state.selfId) return null;
    let peer = state.peers.get(meta.id);
    if (!peer) {
      peer = {
        id: meta.id,
        name: meta.name || '참가자',
        sharing: false,
        pending: false,
        mode: null,
        connState: 'connected',
        stream: new MediaStream(),
        incomingCall: null,
        outgoingCall: null,
        tile: null,
      };
      peer.tile = createTile(peer);
      state.peers.set(peer.id, peer);
      els.grid.appendChild(peer.tile);
    }
    if (meta.name) peer.name = meta.name;
    if (typeof meta.sharing === 'boolean') {
      if (meta.sharing && !peer.sharing) peer.pending = true;
      if (!meta.sharing && !peer.incomingCall) {
        peer.pending = false;
        peer.sharing = false;
      }
    }
    if (meta.mode !== undefined) peer.mode = meta.mode;
    renderPeer(peer);
    updateCount();
    return peer;
  }

  function clearRemoteTracks(peer) {
    if (!peer) return;
    for (const track of peer.stream.getTracks()) {
      try {
        peer.stream.removeTrack(track);
      } catch {
        /* ignore */
      }
    }
    const video = peer.tile?.querySelector('video');
    if (video) video.srcObject = peer.stream;
  }

  function markRemoteStopped(peer) {
    if (!peer) return;
    clearRemoteTracks(peer);
    peer.sharing = false;
    peer.pending = false;
    peer.mode = null;
    peer.connState = 'connected';
    renderPeer(peer);
  }

  function clearRemoteMedia(peer) {
    if (!peer) return;
    const call = peer.incomingCall;
    peer.incomingCall = null;
    if (call) {
      try {
        call.close();
      } catch {
        /* ignore */
      }
    }
    markRemoteStopped(peer);
  }

  function destroyRemotePeer(peer) {
    if (!peer) return;
    if (peer.outgoingCall) {
      try {
        peer.outgoingCall.close();
      } catch {
        /* ignore */
      }
      peer.outgoingCall = null;
    }
    if (peer.incomingCall) {
      try {
        peer.incomingCall.close();
      } catch {
        /* ignore */
      }
      peer.incomingCall = null;
    }
    clearRemoteTracks(peer);
    peer.tile?.remove();
    peer.tile = null;
  }

  function removeRemotePeer(id) {
    const peer = state.peers.get(id);
    if (!peer) return;
    destroyRemotePeer(peer);
    state.peers.delete(id);
    updateCount();
    updateEmpty();
  }

  function resetRemotePeers() {
    for (const peer of state.peers.values()) destroyRemotePeer(peer);
    state.peers.clear();
    els.grid.replaceChildren();
    updateCount();
    updateEmpty();
  }

  function attachRemoteStream(peer, stream) {
    if (!peer || !stream) return;
    for (const track of stream.getTracks()) {
      if (!peer.stream.getTracks().some((item) => item.id === track.id)) {
        peer.stream.addTrack(track);
      }
    }
    const video = peer.tile?.querySelector('video');
    if (video) {
      if (video.srcObject !== peer.stream) video.srcObject = peer.stream;
      video.play().then(
        () => peer.tile?.classList.remove('needs-play'),
        () => peer.tile?.classList.add('needs-play'),
      );
    }
    peer.pending = false;
    peer.sharing = true;
    peer.connState = 'connected';
    renderPeer(peer);
  }

  /* ── 미디어 연결 ───────────────────────────── */
  function onIncomingCall(call) {
    if (!call?.peer || call.peer === state.selfId) return;
    const existing = state.peers.get(call.peer);
    const peer = ensurePeer({
      id: call.peer,
      name: existing ? undefined : (call.peer === state.hostId ? state.hostName : '참가자'),
    });
    if (!peer) return;

    if (peer.incomingCall && peer.incomingCall !== call) {
      try {
        peer.incomingCall.close();
      } catch {
        /* ignore */
      }
      peer.incomingCall = null;
      clearRemoteTracks(peer);
    }

    peer.incomingCall = call;
    peer.pending = true;
    peer.mode = call.metadata?.mode || peer.mode || 'screen';
    peer.connState = 'connecting';
    renderPeer(peer);
    setConnState(peer, 'connecting');

    try {
      call.answer();
    } catch (err) {
      console.warn('수신 통화 응답 실패', err);
      try {
        call.answer(new MediaStream());
      } catch (err2) {
        console.warn('수신 통화 응답 재시도 실패', err2);
      }
    }

    call.on('stream', (remoteStream) => {
      if (peer.incomingCall !== call) return;
      attachRemoteStream(peer, remoteStream);
    });
    call.on('close', () => {
      if (peer.incomingCall !== call) return;
      peer.incomingCall = null;
      markRemoteStopped(peer);
    });
    call.on('error', (err) => {
      console.warn('수신 영상 연결 실패', err);
      if (peer.incomingCall !== call) return;
      peer.incomingCall = null;
      markRemoteStopped(peer);
    });
  }

  function callPeer(peer) {
    if (!state.joined || !state.localStream || !state.peer || !peer?.id) return;
    if (peer.outgoingCall) {
      try {
        peer.outgoingCall.close();
      } catch {
        /* ignore */
      }
      peer.outgoingCall = null;
    }

    let call;
    try {
      call = state.peer.call(peer.id, state.localStream, {
        metadata: { mode: state.localMode },
      });
    } catch (err) {
      console.warn('영상 통화 시작 실패', err);
      showToast(`${peer.name}님에게 영상을 보내지 못했습니다.`);
      return;
    }

    peer.outgoingCall = call;
    peer.connState = 'connecting';
    setConnState(peer, 'connecting');

    call.on('close', () => {
      if (peer.outgoingCall !== call) return;
      peer.outgoingCall = null;
      if (!peer.sharing) setConnState(peer, 'connected');
    });
    call.on('error', (err) => {
      console.warn('영상 통화 오류', err);
      if (peer.outgoingCall === call) peer.outgoingCall = null;
      if (!peer.sharing) setConnState(peer, 'failed');
      showToast(`${peer.name}님과의 영상 연결이 실패했습니다.`);
    });
  }

  function callAllPeers() {
    for (const peer of state.peers.values()) callPeer(peer);
  }

  function closeOutgoingCalls() {
    for (const peer of state.peers.values()) {
      if (!peer.outgoingCall) continue;
      try {
        peer.outgoingCall.close();
      } catch {
        /* ignore */
      }
      peer.outgoingCall = null;
    }
  }

  function closeAllMedia() {
    for (const peer of state.peers.values()) {
      if (peer.outgoingCall) {
        try {
          peer.outgoingCall.close();
        } catch {
          /* ignore */
        }
        peer.outgoingCall = null;
      }
      if (peer.incomingCall) {
        try {
          peer.incomingCall.close();
        } catch {
          /* ignore */
        }
        peer.incomingCall = null;
      }
    }
  }

  function announceShare() {
    if (!state.joined) return;
    const sharing = Boolean(state.localStream);
    const mode = state.localMode;
    if (state.role === 'host') {
      broadcastToGuests({
        type: 'share',
        id: state.selfId,
        name: state.name,
        sharing,
        mode,
      });
    } else if (state.role === 'guest') {
      sendToHost({ type: 'share', sharing, mode });
    }
  }

  /* ── 방장 ──────────────────────────────────── */
  function becomeHost(peer, id, token) {
    if (token !== state.joinToken) {
      try {
        peer.destroy();
      } catch {
        /* ignore */
      }
      return;
    }
    state.role = 'host';
    state.selfId = id;
    state.hostId = id;
    state.hostName = state.name;

    peer.on('connection', onHostConnection);
    peer.on('call', onIncomingCall);
    peer.on('disconnected', onSignalingDisconnected);
    peer.on('close', onSignalingClosed);
    peer.on('error', onHostPeerError);
    peer.on('open', () => {
      if (state.joined && !state.leaving) hideBanner();
    });

    markJoined();
  }

  function onHostPeerError(err) {
    if (state.leaving || state.role !== 'host') return;
    if (
      err?.type === 'network' ||
      err?.type === 'server-error' ||
      err?.type === 'socket-error' ||
      err?.type === 'socket-closed'
    ) {
      setBanner('신호 서버와 연결이 끊겼습니다. 다시 연결하는 중…');
    }
  }

  function onHostConnection(conn) {
    if (state.role !== 'host') {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
      return;
    }

    let joined = false;
    let joinTimer = setTimeout(() => {
      if (joined) return;
      safeSend(conn, {
        type: 'error',
        code: 'join-timeout',
        message: '입장 시간이 초과되었습니다.',
      });
      try {
        conn.close();
      } catch {
        /* ignore */
      }
    }, 10000);

    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'join' && !joined) {
        clearTimeout(joinTimer);
        if (msg.room !== state.room) {
          safeSend(conn, {
            type: 'error',
            code: 'bad-room',
            message: '방 코드가 올바르지 않습니다.',
          });
          try {
            conn.close();
          } catch {
            /* ignore */
          }
          return;
        }
        if (state.peers.size >= MAX_ROOM_SIZE - 1) {
          safeSend(conn, {
            type: 'error',
            code: 'room-full',
            message: `방이 가득 찼습니다. 최대 ${MAX_ROOM_SIZE}명까지 입장할 수 있습니다.`,
          });
          try {
            conn.close();
          } catch {
            /* ignore */
          }
          return;
        }

        joined = true;
        const guestName = safeName(msg.name);
        const existing = state.guestConns.get(conn.peer);
        if (existing && existing !== conn) {
          try {
            existing.close();
          } catch {
            /* ignore */
          }
        }
        state.guestConns.set(conn.peer, conn);
        const peer = ensurePeer({ id: conn.peer, name: guestName, sharing: false, mode: null });

        const roster = [
          {
            id: state.selfId,
            name: state.name,
            sharing: Boolean(state.localStream),
            mode: state.localMode,
          },
          ...[...state.peers.values()]
            .filter((item) => item.id !== conn.peer)
            .map((item) => ({
              id: item.id,
              name: item.name,
              sharing: item.sharing,
              mode: item.mode,
            })),
        ];
        safeSend(conn, {
          type: 'welcome',
          selfId: conn.peer,
          room: state.room,
          maxRoomSize: MAX_ROOM_SIZE,
          peers: roster,
        });
        broadcastToGuests(
          {
            type: 'peer-joined',
            peer: { id: conn.peer, name: guestName, sharing: false, mode: null },
          },
          conn.peer,
        );
        if (state.localStream && peer) callPeer(peer);
        updateCount();
        return;
      }

      if (!joined) return;

      if (msg.type === 'share') {
        const peer = state.peers.get(conn.peer);
        if (!peer) return;
        if (msg.sharing) {
          peer.pending = true;
          peer.mode = msg.mode || null;
        } else {
          peer.pending = false;
          peer.mode = null;
          clearRemoteMedia(peer);
        }
        renderPeer(peer);
        broadcastToGuests(
          {
            type: 'share',
            id: peer.id,
            name: peer.name,
            sharing: Boolean(msg.sharing),
            mode: msg.mode || null,
          },
          conn.peer,
        );
        return;
      }

      if (msg.type === 'leave') {
        removeGuest(conn.peer, conn);
      }
    });

    conn.on('close', () => {
      clearTimeout(joinTimer);
      if (joined) removeGuest(conn.peer, conn);
    });
    conn.on('error', () => {
      clearTimeout(joinTimer);
      if (joined) removeGuest(conn.peer, conn);
    });
  }

  function removeGuest(peerId, conn) {
    const current = state.guestConns.get(peerId);
    if (conn && current && current !== conn) return;
    if (!state.guestConns.has(peerId) && !state.peers.has(peerId)) return;
    state.guestConns.delete(peerId);
    removeRemotePeer(peerId);
    broadcastToGuests({ type: 'peer-left', id: peerId });
    if (conn) {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
    }
    updateCount();
  }

  /* ── 참가자 ────────────────────────────────── */
  function createGuestPeer(token, attempt = 0) {
    if (token !== state.joinToken || state.leaving) return;
    const id = guestIdFor(state.room);
    const peer = new Peer(id, { debug: PEER_DEBUG, config: RTC_CONFIG });
    state.peer = peer;
    let opened = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (opened || settled) return;
      settled = true;
      if (token === state.joinToken) {
        abortJoin('신호 서버 응답이 없습니다. 잠시 후 다시 시도해 주세요.');
      }
    }, 15000);

    peer.on('open', (peerId) => {
      if (token !== state.joinToken || state.leaving) {
        try {
          peer.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      opened = true;
      clearTimeout(timer);
      state.role = 'guest';
      state.selfId = peerId;
      state.hostId = hostIdFor(state.room);
      state.hostName = '방장';
      peer.on('call', onIncomingCall);
      peer.on('disconnected', onSignalingDisconnected);
      peer.on('close', onSignalingClosed);
      peer.on('error', onGuestPeerError);
      peer.on('open', () => {
        if (state.joined && !state.leaving) hideBanner();
      });
      connectToHost(peer, token);
    });

    peer.on('error', (err) => {
      if (opened) return;
      if (err?.type === 'unavailable-id' && attempt < 2) {
        clearTimeout(timer);
        try {
          peer.destroy();
        } catch {
          /* ignore */
        }
        createGuestPeer(token, attempt + 1);
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (token === state.joinToken) abortJoin(describePeerError(err));
    });
  }

  function onGuestPeerError(err) {
    if (state.leaving) return;
    if (err?.type === 'peer-unavailable') {
      if (!state.joined) {
        abortJoin('방을 찾을 수 없습니다. 방 코드를 확인해 주세요.');
      } else {
        showToast('참가자와의 연결이 끊어졌습니다.');
      }
      return;
    }
    if (
      err?.type === 'network' ||
      err?.type === 'server-error' ||
      err?.type === 'socket-error' ||
      err?.type === 'socket-closed'
    ) {
      setBanner('신호 서버와 연결이 끊겼습니다. 다시 연결하는 중…');
    }
  }

  function connectToHost(peer, token) {
    let conn;
    try {
      conn = peer.connect(state.hostId, { reliable: true, serialization: 'json' });
    } catch (err) {
      abortJoin(describePeerError(err));
      return;
    }
    state.hostConn = conn;

    clearTimeout(joinAnswerTimer);
    joinAnswerTimer = setTimeout(() => {
      if (state.joining && state.joinToken === token) {
        abortJoin('방장의 응답이 없습니다. 방 코드를 확인해 주세요.');
      }
    }, 12000);

    conn.on('open', () => {
      if (token !== state.joinToken || state.leaving) return;
      safeSend(conn, { type: 'join', room: state.room, name: state.name });
    });

    conn.on('data', (msg) => {
      if (token !== state.joinToken || state.leaving) return;
      onGuestMessage(msg);
    });

    conn.on('close', () => {
      if (token !== state.joinToken) return;
      clearTimeout(joinAnswerTimer);
      if (state.leaving) return;
      if (!state.joined) {
        abortJoin('방장과 연결하지 못했습니다. 방 코드를 확인해 주세요.');
      } else {
        onHostLost();
      }
    });

    conn.on('error', (err) => {
      if (token !== state.joinToken || state.leaving) return;
      console.warn('방장 연결 오류', err);
      if (!state.joined) {
        abortJoin('방장과 연결하지 못했습니다. 방 코드를 확인해 주세요.');
      }
    });
  }

  function onGuestMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'welcome': {
        clearTimeout(joinAnswerTimer);
        state.joined = true;
        state.joining = false;
        state.selfId = msg.selfId || state.selfId;
        state.hostName =
          (msg.peers || []).find((item) => item.id === state.hostId)?.name || '방장';
        if (msg.maxRoomSize) els.maxRoom.textContent = `최대 ${msg.maxRoomSize}명`;

        for (const meta of msg.peers || []) {
          if (meta.id !== state.selfId) ensurePeer(meta);
        }
        hideBanner();
        updateCount();
        refreshShareUI();
        if (state.localStream) callAllPeers();
        break;
      }
      case 'peer-joined': {
        const peer = ensurePeer(msg.peer);
        if (peer && state.localStream) callPeer(peer);
        break;
      }
      case 'peer-left':
        removeRemotePeer(msg.id);
        break;
      case 'share': {
        if (msg.id === state.selfId) break;
        let peer = state.peers.get(msg.id);
        if (!peer) {
          peer = ensurePeer({
            id: msg.id,
            name: msg.name || (msg.id === state.hostId ? state.hostName : '참가자'),
          });
        }
        if (!peer) break;
        if (msg.sharing) {
          if (!peer.sharing) peer.pending = true;
          peer.mode = msg.mode || null;
          renderPeer(peer);
        } else {
          peer.pending = false;
          peer.mode = null;
          clearRemoteMedia(peer);
        }
        break;
      }
      case 'host-left':
        onHostLost();
        break;
      case 'error':
        showToast(msg.message || '오류가 발생했습니다.');
        if (msg.code === 'room-full' || msg.code === 'bad-room') leaveRoom({ silent: true });
        break;
      default:
        break;
    }
  }

  function onHostLost() {
    if (state.leaving) return;
    showToast('방장이 나가서 방이 종료되었습니다.');
    leaveRoom({ silent: true });
  }

  /* ── 시그널링 수명주기 ─────────────────────── */
  function onSignalingDisconnected() {
    if (state.leaving) return;
    setBanner('신호 서버와 연결이 끊겼습니다. 다시 연결하는 중…');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (state.leaving || !state.peer) return;
      try {
        state.peer.reconnect();
      } catch (err) {
        console.warn('신호 서버 재연결 실패', err);
      }
    }, 1200);
  }

  function onSignalingClosed() {
    if (state.leaving) return;
    if (state.joined) {
      showToast('연결이 종료되었습니다.');
      leaveRoom({ silent: true });
    } else if (state.joining) {
      abortJoin('신호 서버 연결이 종료되었습니다. 다시 시도해 주세요.');
    }
  }

  /* ── 입장 / 퇴장 ───────────────────────────── */
  function joinRoom(event) {
    event.preventDefault();
    if (state.joining || state.joined) return;
    if (typeof Peer === 'undefined') {
      els.landingHint.textContent = 'PeerJS 라이브러리를 불러오지 못했습니다. 페이지를 새로고침해 주세요.';
      return;
    }

    const name = safeName(els.nameInput.value);
    const room = els.roomInput.value.trim().toUpperCase();
    if (!ROOM_RE.test(room)) {
      els.landingHint.textContent = '방 코드는 영문/숫자 3~16자로 입력해 주세요.';
      return;
    }

    state.name = name;
    state.room = room;
    state.hostId = hostIdFor(room);
    state.hostName = '방장';
    state.joining = true;
    state.joined = false;
    state.leaving = false;
    state.joinToken += 1;
    localStorage.setItem('screenShare.name', name);

    els.roomCode.textContent = room;
    els.landingHint.textContent = '';
    els.landing.classList.add('hidden');
    els.roomView.classList.remove('hidden');
    resetRemotePeers();
    els.maxRoom.textContent = `최대 ${MAX_ROOM_SIZE}명`;
    setBanner('방에 연결하는 중…');
    refreshShareUI();
    updateCount();
    configureSecureBanner();

    createHostProbe(state.joinToken);
  }

  function createHostProbe(token) {
    const peer = new Peer(state.hostId, { debug: PEER_DEBUG, config: RTC_CONFIG });
    state.peer = peer;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled || token !== state.joinToken) return;
      settled = true;
      abortJoin('신호 서버 응답이 없습니다. 잠시 후 다시 시도해 주세요.');
    }, 15000);

    peer.on('open', (id) => {
      if (settled || token !== state.joinToken) return;
      settled = true;
      clearTimeout(timer);
      becomeHost(peer, id, token);
    });

    peer.on('error', (err) => {
      if (settled) return;
      if (err?.type === 'unavailable-id') {
        settled = true;
        clearTimeout(timer);
        try {
          peer.destroy();
        } catch {
          /* ignore */
        }
        if (token === state.joinToken) createGuestPeer(token, 0);
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (token === state.joinToken) abortJoin(describePeerError(err));
    });
  }

  function markJoined() {
    state.joining = false;
    state.joined = true;
    hideBanner();
    refreshShareUI();
    updateCount();
  }

  function abortJoin(message) {
    if (state.leaving) return;
    state.joinToken += 1;
    state.joining = false;
    state.joined = false;
    clearTimeout(joinAnswerTimer);

    stopSharing({ silent: true, notify: false });
    closeAllMedia();
    closeAllSignaling();
    resetRemotePeers();

    state.role = null;
    state.selfId = null;
    state.hostId = null;
    state.hostName = '방장';
    state.room = '';
    hideBanner();

    els.roomView.classList.add('hidden');
    els.landing.classList.remove('hidden');
    els.landingHint.textContent = message;
    showToast(message);
    updateCount();
    refreshShareUI();
  }

  function leaveRoom({ silent = false } = {}) {
    if (state.leaving) return;
    state.leaving = true;
    state.joinToken += 1;
    clearTimeout(joinAnswerTimer);
    clearTimeout(reconnectTimer);

    if (state.role === 'host') {
      broadcastToGuests({ type: 'host-left' });
    } else if (state.role === 'guest') {
      sendToHost({ type: 'leave' });
    }

    stopSharing({ silent: true, notify: false });
    closeAllMedia();
    closeAllSignaling();
    resetRemotePeers();

    state.joined = false;
    state.joining = false;
    state.role = null;
    state.selfId = null;
    state.hostId = null;
    state.hostName = '방장';
    state.room = '';
    state.hostConn = null;
    hideBanner();

    els.roomView.classList.add('hidden');
    els.landing.classList.remove('hidden');
    els.shareStatus.textContent = '화면 공유를 시작해 보세요.';
    els.roomInput.value = '';
    els.roomInput.blur();
    els.landingHint.textContent = '';
    updateCount();
    refreshShareUI();
    history.replaceState(null, '', location.pathname);
    state.leaving = false;
    if (!silent) showToast('방에서 나왔습니다.');
  }

  function closeAllSignaling() {
    if (state.hostConn) {
      try {
        state.hostConn.close();
      } catch {
        /* ignore */
      }
      state.hostConn = null;
    }
    for (const conn of state.guestConns.values()) {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
    }
    state.guestConns.clear();
    if (state.peer) {
      try {
        state.peer.destroy();
      } catch {
        /* ignore */
      }
      state.peer = null;
    }
  }

  /* ── 초기화 ────────────────────────────────── */
  function init() {
    if (location.search) history.replaceState(null, '', location.pathname);
    try {
      els.nameInput.value = localStorage.getItem('screenShare.name') || '';
    } catch {
      /* ignore */
    }

    canScreenShare = Boolean(navigator.mediaDevices?.getDisplayMedia);
    els.joinForm.addEventListener('submit', joinRoom);
    els.leave.addEventListener('click', () => leaveRoom());
    els.shareScreen.addEventListener('click', () => startSharing('screen'));
    els.shareCamera.addEventListener('click', () => startSharing('camera'));
    els.shareStop.addEventListener('click', () => stopSharing());
    els.micToggle.addEventListener('click', toggleMic);

    if (!window.isSecureContext) {
      els.landingHint.textContent =
        '보안 연결이 아닙니다. HTTPS 주소로 접속해야 화면·카메라 공유가 가능합니다.';
    }
    if (typeof Peer === 'undefined') {
      els.landingHint.textContent =
        'PeerJS 라이브러리를 불러오지 못했습니다. 페이지를 새로고침해 주세요.';
    }

    refreshShareUI();
    updateCount();
    configureSecureBanner();

    window.addEventListener('beforeunload', () => {
      stopSharing({ silent: true, notify: false });
      if (state.role === 'host') broadcastToGuests({ type: 'host-left' });
      state.peer?.destroy();
    });
  }

  init();
})();
