(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const store = {
    get(area, key) { try { return window[area].getItem(key); } catch { return null; } },
    set(area, key, value) { try { value === null ? window[area].removeItem(key) : window[area].setItem(key, value); } catch {} }
  };

  const REACTIONS = [['thumbs_up', '👍', '엄지척'], ['heart', '❤️', '하트'], ['laugh', '😂', '웃음'], ['surprise', '😮', '놀람'], ['sad', '😢', '슬픔'], ['clap', '👏', '박수']];
  const MAX_IMAGE = 3 * 1024 * 1024;
  const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

  let token = store.get('sessionStorage', 'webchat.session') || '';
  let self = '', roomId = '', rows = [], rendered = [], fingerprint = '', timer, failures = 0;
  let busy = false, syncAgain = false, sending = false, composing = false, draftRevision = 0;
  let replyTarget = null, picker = null, pending = null;
  let readSeq = null, notifiedSeq = 0, boundary = 0, paused = false, anchorPending = true, stickNext = false;
  const reacting = new Set();
  const imageUrls = new Map();

  function setToken(value) { token = value; store.set('sessionStorage', 'webchat.session', value || null); }

  async function api(op, body = {}, ms = 12000) {
    let response, data;
    try {
      response = await fetch('/api/' + op, {
        method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(ms),
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(body)
      });
      data = await response.json();
    } catch { throw new Error('서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요.'); }
    if (!response.ok) { const error = new Error(data.error); error.expired = response.status === 401; throw error; }
    return data;
  }

  const clock = ms => new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const list = $('messages');
  const atEnd = () => list.scrollHeight - list.scrollTop - list.clientHeight < 100;
  const notice = text => { $('notice').textContent = text; };
  const countsAsUnread = row => !row.mine && row.kind !== 'join';
  const unreadCount = () => rows.filter(row => row.seq > readSeq && countsAsUnread(row)).length;
  const coverHidden = () => $('cover').hidden;

  function viewing() {
    return Boolean(token) && !document.hidden && coverHidden() && !$('room').hidden && !$('imageViewer').open && document.hasFocus();
  }

  function renderBody(text) {
    const body = el('div', 'message-body');
    for (const part of text.split(/(https?:\/\/[^\s<>"']*[^\s<>"'.,)!?])/)) {
      if (/^https?:\/\//.test(part)) {
        const link = el('a', '', part);
        link.href = part; link.target = '_blank'; link.rel = 'noopener noreferrer';
        body.append(link);
      } else if (part) body.append(part);
    }
    return body;
  }

  function imageUrl(id) {
    if (!imageUrls.has(id)) {
      const entry = { url: '', promise: null };
      entry.promise = fetch('/api/image/' + id, { cache: 'no-store', headers: { Authorization: 'Bearer ' + token } })
        .then(response => { if (!response.ok) throw new Error(); return response.blob(); })
        .then(blob => { entry.url = URL.createObjectURL(blob); return entry.url; });
      entry.promise.catch(() => imageUrls.delete(id));
      imageUrls.set(id, entry);
    }
    return imageUrls.get(id);
  }

  function pruneImages() {
    const live = new Set(rows.map(row => row.id));
    for (const [id, entry] of imageUrls) {
      if (!live.has(id)) { if (entry.url) URL.revokeObjectURL(entry.url); imageUrls.delete(id); }
    }
    if ($('imageViewer').open && !live.has($('imageViewer').dataset.id)) $('imageViewer').close();
  }

  function renderImage(row) {
    const button = el('button', 'chat-image'), img = el('img');
    button.type = 'button'; button.setAttribute('aria-label', '이미지 확대');
    img.alt = row.name + '님이 보낸 이미지';
    button.append(img);
    const entry = imageUrl(row.id);
    const show = url => {
      img.src = url;
      button.onclick = () => openViewer(row, url);
    };
    if (entry.url) show(entry.url);
    else entry.promise.then(url => {
      const stick = atEnd();
      img.onload = () => { if (stick && viewing()) list.scrollTop = list.scrollHeight; };
      show(url);
    }).catch(() => { button.replaceWith(el('div', 'message-body', '이미지를 불러오지 못했습니다.')); });
    return button;
  }

  function openViewer(row, url) {
    const viewer = $('imageViewer');
    viewer.dataset.id = row.id;
    $('viewerImage').src = url;
    $('imageStage').classList.remove('actual');
    $('viewerZoom').textContent = '100%로 보기';
    $('viewerExpiry').textContent = clock(row.expires_at) + ' 삭제 예정';
    viewer.showModal();
  }

  function selectReply(row) {
    replyTarget = row.id;
    $('replyPreview').hidden = false;
    $('replyPreviewText').textContent = `${row.name}에게 답장 · ${row.kind === 'image' ? '[사진] ' : ''}${row.body.slice(0, 180)}`;
    $('draft').focus();
  }
  function clearReply() { replyTarget = null; $('replyPreview').hidden = true; $('replyPreviewText').textContent = ''; }

  function jumpTo(id) {
    const target = rendered.find(item => item.row.id === id);
    if (!target) { notice('원문이 현재 목록에 없습니다.'); return; }
    list.scrollTop = Math.max(0, target.element.offsetTop - list.offsetTop - 20);
    target.element.tabIndex = -1;
    target.element.focus({ preventScroll: true });
  }

  async function react(row, key) {
    if (reacting.has(row.id)) return;
    const selected = row.reactions.some(item => item.key === key && item.mine);
    reacting.add(row.id); picker = null;
    fingerprint = ''; paint();
    try { await api('react', { id: row.id, key: selected ? 'off' : key }); await sync(); }
    catch (error) { notice(error.message); }
    finally { reacting.delete(row.id); fingerprint = ''; paint(); }
  }

  function renderReactions(row) {
    const bar = el('div', 'message-reactions');
    const reply = el('button', 'reply-button', '답장');
    reply.type = 'button'; reply.onclick = () => selectReply(row);
    bar.append(reply);
    for (const item of row.reactions) {
      const type = REACTIONS.find(([key]) => key === item.key);
      if (!type) continue;
      const chip = el(row.mine ? 'span' : 'button', 'reaction-chip' + (item.mine ? ' selected' : ''), `${type[1]} ${item.count}`);
      if (!row.mine) {
        chip.type = 'button'; chip.disabled = reacting.has(row.id);
        chip.setAttribute('aria-pressed', String(item.mine));
        chip.setAttribute('aria-label', type[2] + (item.mine ? ' 취소' : ' 반응'));
        chip.onclick = () => react(row, item.key);
      }
      bar.append(chip);
    }
    if (!row.mine) {
      const add = el('button', 'reaction-add', '+');
      add.type = 'button'; add.disabled = reacting.has(row.id);
      add.setAttribute('aria-label', '이모티콘 반응 선택');
      add.setAttribute('aria-expanded', String(picker === row.id));
      add.onclick = () => { picker = picker === row.id ? null : row.id; paint(); };
      bar.append(add);
      if (picker === row.id) {
        const group = el('div', 'reaction-picker');
        group.setAttribute('role', 'group'); group.setAttribute('aria-label', '반응 선택');
        for (const [key, emoji, label] of REACTIONS) {
          const option = el('button', 'reaction-option', emoji);
          option.type = 'button'; option.title = label; option.setAttribute('aria-label', label);
          option.setAttribute('aria-pressed', String(row.reactions.some(item => item.key === key && item.mine)));
          option.onclick = () => react(row, key);
          group.append(option);
        }
        bar.append(group);
      }
    }
    return bar;
  }

  function renderEntry(row) {
    const entry = el('article', 'entry' + (row.mine ? ' mine' : ''));
    const content = el('div', 'entry-content'), head = el('div', 'entry-head');
    const time = el('time', '', clock(row.created_at));
    time.title = '삭제 예정: ' + new Date(row.expires_at).toLocaleTimeString('ko-KR');
    head.append(el('strong', '', row.name + (row.mine ? ' · 나' : '')), time);
    if (row.mine) {
      const remove = el('button', '', '삭제');
      remove.type = 'button';
      remove.onclick = async () => {
        remove.disabled = true;
        try { await api('delete', { id: row.id }); await sync(); }
        catch (error) { notice(error.message); remove.disabled = false; }
      };
      head.append(remove);
    }
    content.append(head);
    if (row.reply_to) {
      const quote = el('button', 'reply-quote');
      quote.type = 'button';
      if (row.reply) {
        quote.append(el('strong', '', `${row.reply.name}에게 답장`), el('span', '', `${row.reply.kind === 'image' ? '[사진] ' : ''}${row.reply.body}`));
        quote.onclick = () => jumpTo(row.reply_to);
      } else { quote.textContent = '삭제되었거나 만료된 메시지에 대한 답장'; quote.disabled = true; }
      content.append(quote);
    }
    if (row.kind === 'image') content.append(renderImage(row));
    if (row.body) content.append(renderBody(row.body));
    content.append(renderReactions(row));
    entry.append(content);
    return entry;
  }

  function updateUnread() {
    const count = unreadCount();
    $('newMessages').hidden = count === 0;
    $('newMessages').textContent = `안 읽은 메시지 ${count}개 · 이동 ↓`;
  }

  function markRead() {
    if (!viewing() || readSeq === null) return;
    const view = list.getBoundingClientRect();
    for (const { element, row } of rendered) {
      const box = element.getBoundingClientRect();
      if (box.bottom <= view.bottom + 2 && box.bottom > view.top && row.seq > readSeq) readSeq = row.seq;
    }
    store.set('localStorage', `webchat.read.${roomId}.${self}`, String(readSeq));
    updateUnread();
  }

  function paint() {
    const mark = JSON.stringify([rows, boundary, picker, [...reacting]]);
    if (mark === fingerprint) { markRead(); return; }
    fingerprint = mark;
    const stick = atEnd(), oldTop = list.scrollTop;
    list.replaceChildren();
    rendered = [];
    let divider = null;
    const firstUnread = rows.find(row => row.seq > boundary && countsAsUnread(row));
    if (!rows.length) list.append(el('div', 'empty', '// 연결되었습니다.\n첫 메시지를 남겨보세요.'));
    for (const row of rows) {
      if (row === firstUnread) { divider = el('div', 'unread-divider', '여기부터 새 메시지'); list.append(divider); }
      let element;
      if (row.kind === 'join') {
        element = el('div', 'join-event');
        element.append(el('span', '', row.name + '님이 입장했습니다.'), el('time', '', clock(row.created_at)));
      } else element = renderEntry(row);
      list.append(element);
      rendered.push({ element, row });
    }
    if (anchorPending && viewing()) {
      list.scrollTop = divider ? Math.max(0, divider.offsetTop - list.offsetTop) : list.scrollHeight;
      anchorPending = false;
    } else if (stickNext || (stick && viewing())) list.scrollTop = list.scrollHeight;
    else list.scrollTop = oldTop;
    stickNext = false;
    updateUnread();
    markRead();
  }

  function renderMembers(members) {
    $('count').textContent = `${members.length} / 7`;
    $('members').replaceChildren(...members.map(member => {
      const line = el('div', 'member'), presence = el('span', member.online ? 'online' : 'online away');
      presence.title = member.online ? '접속 중' : '자리 비움 · 접속 유지 중';
      line.append(el('span', 'avatar', [...member.name][0]), el('span', 'member-name', member.name), presence);
      if (!member.online) line.append(el('small', 'member-away', '자리 비움'));
      return line;
    }));
    const online = members.filter(member => member.online).length;
    $('status').textContent = `${self} · ${online}명 활동 / ${members.length}명 입장`;
  }

  function reset() {
    clearTimeout(timer);
    clearReply(); clearPending();
    setToken('');
    self = ''; roomId = ''; rows = []; rendered = []; fingerprint = ''; picker = null;
    readSeq = null; boundary = 0; paused = false; anchorPending = true;
    pruneImages();
    list.replaceChildren(); $('members').replaceChildren();
    $('count').textContent = '0 / 7'; $('draft').value = '';
    $('room').hidden = true; $('gate').hidden = false; $('logout').hidden = true;
    $('connection').textContent = 'OFFLINE'; $('status').textContent = '연결 대기';
  }

  async function sync() {
    if (!token) return;
    if (busy) { syncAgain = true; return; }
    busy = true;
    const session = token;
    try {
      const data = await api('sync', { active: !document.hidden && coverHidden() });
      if (token !== session) return;
      const maxSeq = items => items.reduce((max, row) => Math.max(max, row.seq), 0);
      const latest = maxSeq(data.messages);
      if (self !== data.name || roomId !== data.room) {
        self = data.name; roomId = data.room;
        const saved = Number(store.get('localStorage', `webchat.read.${roomId}.${self}`));
        readSeq = saved > 0 ? saved : latest;
        boundary = readSeq; notifiedSeq = latest;
      } else if (latest > maxSeq(rows) && viewing() && !anchorPending && atEnd() && unreadCount() === 0) boundary = latest;
      notifyNew(data.messages.filter(row => row.seq > notifiedSeq && countsAsUnread(row)));
      notifiedSeq = Math.max(notifiedSeq, latest);
      rows = data.messages;
      failures = 0;
      if (replyTarget && !rows.some(row => row.id === replyTarget)) $('replyPreviewText').textContent = '삭제되었거나 만료된 원문 · 취소 후 일반 메시지로 보내세요';
      pruneImages();
      $('connection').textContent = 'CONNECTED';
      $('gate').hidden = true; $('room').hidden = false; $('logout').hidden = false;
      renderMembers(data.members);
      paint();
    } catch (error) {
      if (token !== session) return;
      failures++;
      $('connection').textContent = 'RECONNECTING';
      if (error.expired) { reset(); $('loginError').textContent = '접속이 만료되었거나 같은 이름으로 다른 곳에서 로그인했습니다. 다시 입장해 주세요.'; }
      else if (!$('gate').hidden) $('loginError').textContent = error.message;
      else notice(error.message);
    } finally {
      busy = false;
      if (syncAgain) { syncAgain = false; sync(); }
    }
  }

  // 내용은 싣지 않는다: 알림 센터에 대화 흔적이 남지 않도록 현재 테마에 맞춘 위장 문구만 보인다.
  // 같은 tag로 교체하면 브라우저가 두 번째부터 조용히 바꿔치기만 하므로, 이전 알림을 닫고 새로 띄운다.
  let lastNote = null;
  function notifyNew(fresh) {
    if (!fresh.length || viewing() || !$('notify').checked || !('Notification' in window) || Notification.permission !== 'granted') return;
    lastNote?.close();
    const theme = THEMES[document.body.dataset.theme];
    const note = lastNote = new Notification(theme.title, { body: theme.alert });
    note.onclick = () => { window.focus(); note.close(); };
  }

  async function poll() {
    clearTimeout(timer);
    await sync();
    clearTimeout(timer);
    if (token) timer = setTimeout(poll, document.hidden ? 10000 : Math.min(15000, 2000 * (1 + failures)));
  }

  function pauseReading() {
    if (paused || readSeq === null) return;
    paused = true; boundary = readSeq; anchorPending = true;
  }
  function resumeReading() {
    if (!viewing()) return;
    const wasPaused = paused;
    paused = false;
    if (anchorPending) fingerprint = '';
    paint();
    if (wasPaused) poll();
  }

  $('loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter; button.disabled = true;
    $('loginError').textContent = '';
    try {
      const data = await api('login', { name: $('name').value.trim(), password: $('password').value });
      setToken(data.token);
      $('password').value = '';
      await poll();
    } catch (error) { $('loginError').textContent = error.message; }
    finally { button.disabled = false; }
  });

  $('logout').addEventListener('click', async () => {
    try { await api('leave'); } catch (error) { notice('나가기 실패: ' + error.message); return; }
    reset();
  });

  function clearPending() {
    if (pending) URL.revokeObjectURL(pending.url);
    pending = null;
    $('imagePreview').hidden = true; $('imageFile').value = '';
  }

  async function shrink(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
    const canvas = el('canvas');
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  }

  async function attach(file) {
    if (!IMAGE_TYPES.includes(file.type)) { notice('JPEG, PNG, WebP 이미지만 보낼 수 있습니다.'); return; }
    let blob = file;
    if (blob.size > MAX_IMAGE) {
      try { blob = await shrink(file); } catch { notice('이미지를 처리하지 못했습니다.'); return; }
      if (!blob || blob.size > MAX_IMAGE) { notice('이미지는 3MB 이하만 보낼 수 있습니다.'); return; }
    }
    clearPending();
    pending = { blob, url: URL.createObjectURL(blob) };
    $('previewImage').src = pending.url;
    $('imageSize').textContent = `${(blob.size / 1024 / 1024).toFixed(2)}MB · 전송 후 5분 뒤 삭제`;
    $('imagePreview').hidden = false;
    notice('');
    $('draft').focus();
  }

  const toBase64 = blob => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    reader.onerror = () => reject(new Error('이미지를 읽지 못했습니다.'));
    reader.readAsDataURL(blob);
  });

  $('attachImage').onclick = () => $('imageFile').click();
  $('imageFile').onchange = event => { if (event.target.files[0]) attach(event.target.files[0]); };
  $('cancelImage').onclick = clearPending;
  $('cancelReply').onclick = clearReply;
  $('draft').addEventListener('paste', event => {
    const item = [...event.clipboardData.items].find(entry => entry.type.startsWith('image/'));
    if (item) { event.preventDefault(); attach(item.getAsFile()); }
  });
  const room = $('room');
  let dragDepth = 0;
  room.addEventListener('dragenter', event => { event.preventDefault(); dragDepth++; room.classList.add('dragging'); });
  room.addEventListener('dragover', event => event.preventDefault());
  room.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; room.classList.remove('dragging'); } });
  room.addEventListener('drop', event => {
    event.preventDefault(); dragDepth = 0; room.classList.remove('dragging');
    if (event.dataTransfer.files[0]) attach(event.dataTransfer.files[0]);
  });

  const draft = $('draft');
  draft.addEventListener('compositionstart', () => { composing = true; });
  draft.addEventListener('compositionend', () => { composing = false; });
  draft.addEventListener('input', () => { draftRevision++; });
  draft.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !composing && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      $('sendForm').requestSubmit();
    }
  });

  $('sendForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (sending || !token || composing) return;
    const original = draft.value, body = original.trim();
    if (!body && !pending) return;
    const session = token, revision = draftRevision, reply = replyTarget;
    sending = true; $('sendButton').disabled = true;
    draft.value = '';
    try {
      if (pending) await api('image', { data: await toBase64(pending.blob), body, reply_to: reply || '' }, 60000);
      else await api('send', { body, reply_to: reply || '' });
      if (token !== session) return;
      clearPending();
      if (replyTarget === reply) clearReply();
      notice('');
      boundary = Number.MAX_SAFE_INTEGER;
      stickNext = true;
      await sync();
    } catch (error) {
      if (token !== session) return;
      if (draft.value === '' && draftRevision === revision) { draft.value = original; notice(error.message + ' 입력 내용을 복원했습니다.'); }
      else notice(error.message + ' 새로 작성 중인 내용은 유지했습니다.');
    } finally {
      sending = false; $('sendButton').disabled = false;
      if (coverHidden()) draft.focus();
    }
  });

  $('newMessages').onclick = () => {
    const next = rendered.find(item => item.row.seq > readSeq && countsAsUnread(item.row));
    list.scrollTop = next ? Math.max(0, next.element.offsetTop - list.offsetTop) : list.scrollHeight;
    markRead();
  };
  list.addEventListener('scroll', () => requestAnimationFrame(markRead), { passive: true });

  $('viewerClose').onclick = () => $('imageViewer').close();
  $('viewerZoom').onclick = () => {
    const actual = $('imageStage').classList.toggle('actual');
    $('viewerZoom').textContent = actual ? '화면에 맞추기' : '100%로 보기';
  };
  $('imageViewer').addEventListener('close', () => { $('viewerImage').removeAttribute('src'); });

  const SHELL = ['workspaceHeader', 'workspaceShell', 'workspaceFooter'];
  let previousFocus = null;
  function showCover() {
    pauseReading();
    if (!coverHidden()) return;
    previousFocus = document.activeElement;
    $('cover').hidden = false;
    SHELL.forEach(id => { $(id).inert = true; });
    $('resume').focus();
  }
  function hideCover() {
    $('cover').hidden = true;
    SHELL.forEach(id => { $(id).inert = false; });
    if (previousFocus?.isConnected) previousFocus.focus();
    resumeReading();
  }
  $('coverButton').onclick = showCover;
  $('resume').onclick = hideCover;
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.repeat || event.isComposing) return;
    event.preventDefault();
    if ($('imageViewer').open) $('imageViewer').close();
    coverHidden() ? showCover() : hideCover();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      pauseReading();
      if ($('autoCover').checked) showCover();
    } else if (token) { resumeReading(); poll(); }
  });
  $('notify').checked = store.get('localStorage', 'webchat.notify') === '1' && 'Notification' in window && Notification.permission === 'granted';
  $('notify').addEventListener('change', async event => {
    const box = event.target;
    if (box.checked) {
      if (!('Notification' in window) || !window.isSecureContext) { box.checked = false; notice('이 브라우저/주소(HTTPS 또는 localhost 필요)에서는 데스크톱 알림을 쓸 수 없습니다.'); }
      else if (await Notification.requestPermission() !== 'granted') { box.checked = false; notice('브라우저 또는 OS 설정에서 이 사이트의 알림이 차단되어 있습니다.'); }
    }
    store.set('localStorage', 'webchat.notify', box.checked ? '1' : null);
  });
  window.addEventListener('blur', pauseReading);
  window.addEventListener('focus', resumeReading);

  const THEMES = {
    code: {
      brand: 'STUDIO', title: 'team-workspace — project', alert: '✓ Tests passed · 0 errors, 0 warnings', heading: 'EXPLORER', project: 'TEAM WORKSPACE',
      tree: ['workspace', 'src', '# team.log', 'config.json', 'README.md'], file: 'team.log', path: 'workspace › src › team.log', footer: 'UTF-8　 TypeScript　 ◉ Private',
      cover: { kind: 'code', status: 'Ln 12, Col 3　 Spaces: 2　 UTF-8　 TypeScript', tree: ['⌄ WORKSPACE', '  › node_modules', '  ⌄ src', '      queue.ts', '      retry.ts', '  package.json', '  tsconfig.json'],
        terminal: ['TERMINAL', 'workspace % npm test', ' PASS  src/queue.test.ts', '  ✓ drains jobs in insertion order (3 ms)', '  ✓ retries a failed job twice (1 ms)', 'Tests  2 passed (2)'],
        files: [
          { name: 'queue.ts', path: 'src › queue.ts', src: `import { withRetry } from './retry';\n\nexport interface Job {\n  id: string;\n  run: () => Promise<void>;\n}\n\n// Runs jobs one at a time, in the order they were added.\nexport class JobQueue {\n  private jobs: Job[] = [];\n  private draining = false;\n\n  add(job: Job) {\n    this.jobs.push(job);\n    return this.drain();\n  }\n\n  private async drain() {\n    if (this.draining) return;\n    this.draining = true;\n    while (this.jobs.length > 0) {\n      const job = this.jobs.shift() as Job;\n      await withRetry(job.run, 2);\n    }\n    this.draining = false;\n  }\n}` },
          { name: 'retry.ts', path: 'src › retry.ts', src: `export async function withRetry(\n  task: () => Promise<void>,\n  attempts: number,\n) {\n  for (let i = 0; i <= attempts; i++) {\n    try {\n      return await task();\n    } catch (error) {\n      if (i === attempts) throw error;\n      await sleep(250 * 2 ** i);\n    }\n  }\n}\n\nconst sleep = (ms: number) =>\n  new Promise((done) => setTimeout(done, ms));` }
        ] }
    },
    sheet: {
      brand: 'SHEETS', title: 'Team workspace · Workbook', alert: '공유 통합 문서가 업데이트되었습니다.', heading: 'WORKBOOK', project: 'TEAM OPERATIONS',
      tree: ['Workbook', 'Worksheets', 'Team notes', 'Summary', 'Resources'], file: 'Team notes', path: 'Workbook › Worksheets › Team notes', footer: 'Ready　 Notes　 ◉ Private',
      cover: { kind: 'sheet', status: 'Ready　 Sum: 12,480　 100%', tree: ['⌄ Worksheets', '   Q4 Budget', '   Headcount', '   Vendors'], sheets: ['Q4 Budget', 'Headcount', 'Vendors'],
        table: [['항목', '10월', '11월', '12월', '합계'], ['인프라', 1200, 1250, 1310, 3760], ['라이선스', 840, 840, 900, 2580], ['출장', 320, 410, 150, 880], ['교육', 200, 180, 260, 640], ['장비', 1500, 2100, 1020, 4620]] }
    },
    android: {
      brand: 'TaskApp', title: 'app  ›  Pixel Emulator', alert: 'BUILD SUCCESSFUL in 6s', heading: 'PROJECT', project: 'ANDROID',
      tree: ['app', 'src / main', 'TaskAppFunctionService.kt', 'AndroidManifest.xml', 'build.gradle.kts'], file: 'Logcat', path: 'app › com.example.tasks › Logcat', footer: 'UTF-8　 Kotlin　 ◉ Private',
      cover: { kind: 'code', status: 'Line 14, Col 3　 Kotlin　 BUILD SUCCESSFUL', tree: ['⌄ app', '  ⌄ src/main', '    ⌄ appfunctions', '        TaskAppFunctionService.kt', '        CreateTaskParams.kt', '      AndroidManifest.xml', '  build.gradle.kts'],
        terminal: ['TERMINAL', '$ adb shell cmd app_function list-app-functions --package com.example.tasks', 'com.example.tasks', '  BaseTaskAppFunctionService#createTask    enabled', 'BUILD SUCCESSFUL in 6s'],
        files: [
          { name: 'TaskAppFunctionService.kt', path: 'app › com.example.tasks › TaskAppFunctionService.kt', src: `@RequiresApi(36)\n@AndroidEntryPoint\n@AppFunctionServiceEntryPoint(\n  serviceName = "TaskAppFunctionService",\n  appFunctionXmlFileName = "task_app_function_service",\n)\nabstract class BaseTaskAppFunctionService : AppFunctionService() {\n  @Inject internal lateinit var taskRepository: TaskRepository\n\n  /**\n   * Creates a task based on [createTaskParams].\n   */\n  @AppFunctionDeclaration(isDescribedByKDoc = true)\n  suspend fun createTask(\n    createTaskParams: CreateTaskParams,\n  ): Task = withContext(Dispatchers.IO) {\n    // Predefined exceptions tell the agent why it failed.\n    if (createTaskParams.title == null && createTaskParams.content == null) {\n      throw AppFunctionInvalidArgumentException("Title or content should be non-null")\n    }\n\n    val id = taskRepository.createTask(\n      createTaskParams.title,\n      createTaskParams.content\n    )\n\n    return@withContext taskRepository\n      .getTask(id)\n      ?.toTask()\n      ?: throw AppFunctionElementNotFoundException("Task not found for ID = $id")\n  }\n\n  // Maps internal TaskEntity\n  private fun TaskEntity.toTask() = Task(id = id, title = title, content = description)\n}` },
          { name: 'CreateTaskParams.kt', path: 'app › com.example.tasks › CreateTaskParams.kt', src: `/** The parameter to create the task. */\n@AppFunctionSerializable(isDescribedByKDoc = true)\ndata class CreateTaskParams(\n  /** The title of the task. */\n  val title: String?,\n  /** The content of the task. */\n  val content: String?,\n)\n\n/** The user-created task. */\n@AppFunctionSerializable(isDescribedByKDoc = true)\ndata class Task(\n  /** The ID of the task. */\n  val id: String,\n  /** The title of the task. */\n  val title: String,\n  /** The content of the task. */\n  val content: String,\n)` }
        ] }
    }
  };

  const KEYWORDS = 'import|from|export|interface|class|private|async|await|function|const|let|return|if|while|for|try|catch|throw|new|as|package|data|val|var|fun|suspend|abstract|override|null|lateinit|internal';
  const TOKEN = new RegExp(`(//.*$|'[^']*'|"[^"]*"|\\b(?:${KEYWORDS})\\b|\\b\\d+\\b|\\b[A-Z][A-Za-z]+\\b)`, 'g');
  const syntaxClass = part => {
    if (part.startsWith('//')) return 'syntax-comment';
    if (part.startsWith("'") || part.startsWith('"')) return 'syntax-string';
    if (/^\d+$/.test(part)) return 'syntax-number';
    if (/^[A-Z]/.test(part)) return 'syntax-type';
    return new RegExp(`^(?:${KEYWORDS})$`).test(part) ? 'syntax-keyword' : '';
  };

  function coverTabs(names, selected, onPick) {
    $('coverTabs').replaceChildren(...names.map(name => {
      const tab = el('button', name === selected ? 'selected' : '', name);
      tab.type = 'button';
      if (onPick) tab.onclick = () => onPick(name);
      return tab;
    }));
  }

  function showCoverFile(cover, name) {
    const file = cover.files.find(item => item.name === name);
    coverTabs(cover.files.map(item => item.name), name, next => showCoverFile(cover, next));
    $('coverPath').textContent = file.path;
    $('coverBody').replaceChildren(...file.src.split('\n').map((line, index) => {
      const row = el('div', 'code-line'), code = el('span');
      for (const part of line.split(TOKEN)) if (part) code.append(el('span', syntaxClass(part), part));
      row.append(el('span', 'code-gutter', String(index + 1)), code);
      return row;
    }));
    $('coverBody').scrollTop = 0;
  }

  function renderCover(theme) {
    const cover = theme.cover;
    $('coverSearch').textContent = '⌕　' + theme.title;
    $('coverHeading').textContent = theme.heading;
    $('coverStatus').textContent = cover.status;
    $('coverTree').replaceChildren(...cover.tree.map(line => el('div', '', line)));
    $('coverTerminal').hidden = cover.kind !== 'code';
    if (cover.kind === 'code') {
      $('coverTerminal').replaceChildren(...cover.terminal.map(line => el('div', '', line)));
      showCoverFile(cover, cover.files[0].name);
    } else {
      coverTabs(cover.sheets, cover.sheets[0]);
      $('coverPath').textContent = 'A1';
      const table = el('table', 'sheet-grid'), header = el('tr');
      header.append(el('th'), ...'ABCDE'.split('').map(letter => el('th', '', letter)));
      table.append(header);
      cover.table.forEach((cells, index) => {
        const row = el('tr');
        row.append(el('th', '', String(index + 1)));
        for (const cell of cells) row.append(el('td', typeof cell === 'number' ? 'num' : '', typeof cell === 'number' ? cell.toLocaleString('en-US') : cell));
        table.append(row);
      });
      $('coverBody').replaceChildren(table);
    }
  }

  function applyTheme(key) {
    const theme = THEMES[key];
    document.body.dataset.theme = key;
    $('themeSelect').value = key;
    $('brand').textContent = theme.brand;
    $('windowTitle').textContent = theme.title;
    $('sideHeading').textContent = theme.heading;
    $('sideProject').textContent = theme.project;
    $('fileTab').textContent = theme.file;
    $('crumb').textContent = theme.path;
    $('footerRight').textContent = theme.footer;
    $('tree').replaceChildren(...theme.tree.map((text, index) => el(index === 2 ? 'strong' : 'span', '', (index < 2 ? '⌄ ' : '　') + text)));
    renderCover(theme);
    store.set('localStorage', 'webchat.theme', key);
  }
  $('themeSelect').onchange = event => applyTheme(event.target.value);
  const savedTheme = store.get('localStorage', 'webchat.theme');
  applyTheme(Object.hasOwn(THEMES, savedTheme || '') ? savedTheme : 'code');

  if (token) poll();
})();
