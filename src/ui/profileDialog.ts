import { ApiError, api } from '../net/api';
import {
  AVATAR_ANIM_MAX_BYTES, AVATAR_ANIM_MAX_SIZE, DISPLAY_NAME_MAX, HANDLE_MAX, STATUS_MAX, cleanStatus, LINK_PLATFORMS, MyProfile,
  graphemeCount, handleError, normalizeColor, normalizeLink, sanitizeDisplayName, validateDisplayName,
} from '../shared/profile';
import { cropAvatar, makeAvatar } from './avatarCrop';
import { h } from './dom';
import { icon } from './icons';
import { avatarEl, badges, gradientStyle } from './people';
import { modal } from './dialogs';

/**
 * Profile editor. Used once after the first login (setup) and later from the account menu.
 * Resolves with the saved profile, or null if closed without saving.
 */
export function profileDialog(me: MyProfile, setup: boolean): Promise<MyProfile | null> {
  return new Promise((resolve) => {
    let current = me;
    let saved: MyProfile | null = null;
    const errors = new Map<string, HTMLElement>();
    const err = (key: string) => { const e = h('p.field-error', { role: 'alert' }); errors.set(key, e); return e; };
    const showErr = (key: string, msg: string) => { const e = errors.get(key) ?? errors.get('form')!; e.textContent = msg; };

    // Avatar
    const avatarBox = h('div.avatar-edit');
    const renderAvatar = () => {
      avatarBox.replaceChildren(avatarEl({ ...current, displayName: nameIn.value || current.displayName, favoriteColor: colorIn.value }, 72, true));
      namePreview.textContent = sanitizeDisplayName(nameIn.value) || current.displayName;
      namePreview.className = gradOn.checked && current.premium ? 'gradient-name' : '';
      namePreview.setAttribute('style', gradOn.checked && current.premium ? gradientStyle([g1.value, g2.value]) : '');
    };
    const namePreview = h('span');
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', id: 'avatar-file', hidden: true });
    const upload = h('button.btn', { type: 'button', onclick: () => file.click() }, 'Upload picture');
    const remove = h('button.btn', { type: 'button' }, 'Remove');
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      file.value = '';
      if (!f) return;
      try {
        upload.disabled = true;
        const crop = await cropAvatar(f);
        if (!crop) return;
        current = await api.uploadAvatar(await makeAvatar(f, crop));
        showErr('avatar', '');
        renderAvatar();
      } catch (e) { showErr('avatar', (e as Error).message); } finally { upload.disabled = false; }
    });
    remove.addEventListener('click', async () => { current = await api.deleteAvatar(); renderAvatar(); });

    // Handle. Accounts pick any free handle (new Discord accounts start with their Discord
    // username); guests keep a random <Word><Food> one and can only shuffle it.
    const guest = me.provider === 'guest';
    const handleIn = h('input', { type: 'text', id: 'handle', value: me.handle, maxlength: HANDLE_MAX, spellcheck: 'false', autocapitalize: 'off', autocomplete: 'username', 'aria-label': 'Handle' });
    const handleState = h('small.handle-state', { 'aria-live': 'polite' });
    let checkTimer = 0, checkSeq = 0;
    const setState = (kind: '' | 'ok' | 'bad' | 'wait', text: string) => { handleState.className = 'handle-state ' + kind; handleState.textContent = text; };
    const checkHandle = () => {
      clearTimeout(checkTimer);
      const v = handleIn.value.trim().replace(/^@/, '');
      if (v.toLowerCase() === current.handle.toLowerCase()) { setState('ok', v === current.handle ? 'This is your handle.' : 'Available'); return; }
      const bad = handleError(v);
      if (bad) { setState('bad', bad); return; }
      setState('wait', 'Checking…');
      const seq = ++checkSeq;
      checkTimer = window.setTimeout(async () => {
        try {
          const r = await api.checkHandle(v);
          if (seq !== checkSeq) return;
          setState(r.available ? 'ok' : 'bad', r.available ? `@${v} is available` : r.error ?? `@${v} is taken.`);
        } catch { if (seq === checkSeq) setState('', ''); }
      }, 300);
    };
    handleIn.addEventListener('input', () => { showErr('handle', ''); checkHandle(); });
    const shuffle = h('button.btn', { type: 'button', html: icon('rotate', 16) + '<span>Shuffle</span>' });
    shuffle.addEventListener('click', async () => { handleIn.value = (await api.randomHandle()).handle; });
    if (guest) handleIn.readOnly = true;
    const handle = () => handleIn.value.trim().replace(/^@/, '');
    const handleHint = guest
      ? 'Guests get a random handle. Log in with Discord to choose your own.'
      : setup && me.provider === 'discord'
        ? 'We suggested your Discord username. Change it to anything you like.'
        : 'Letters, numbers, underscores and periods. This is how friends find you.';
    const handleField = h('div.field', {},
      h('label.field-label', { for: 'handle' }, 'Handle'),
      h('div.row.handle-row', {}, h('span.handle-input', {}, h('span.at', {}, '@'), handleIn), guest ? shuffle : null),
      guest ? null : handleState,
      h('small.muted', {}, handleHint), err('handle'),
    );
    if (!guest) checkHandle();

    // Display name
    const nameIn = h('input', { type: 'text', id: 'display-name', value: me.displayName, maxlength: DISPLAY_NAME_MAX * 2, autocomplete: 'nickname', 'aria-label': 'Display name' });
    const counter = h('span.counter');
    const checkName = () => {
      const clean = sanitizeDisplayName(nameIn.value);
      counter.textContent = `${graphemeCount(clean)}/${DISPLAY_NAME_MAX}`;
      showErr('displayName', nameIn.value.trim() ? validateDisplayName(clean) ?? '' : '');
      renderAvatar();
    };
    nameIn.addEventListener('input', checkName);

    // Status message
    const statusIn = h('input', { type: 'text', id: 'status', value: me.status ?? '', maxlength: STATUS_MAX * 2, placeholder: 'Working on a comic, open to collabs…', 'aria-label': 'Status message' });
    const statusCount = h('span.counter');
    const checkStatus = () => {
      const c = cleanStatus(statusIn.value);
      statusCount.textContent = `${graphemeCount(sanitizeDisplayName(statusIn.value))}/${STATUS_MAX}`;
      showErr('status', c === null ? `Keep it to ${STATUS_MAX} characters.` : '');
    };
    statusIn.addEventListener('input', checkStatus);

    // Premium: name gradient and animated picture
    const premium = me.premium;
    const g = me.gradient ?? [me.favoriteColor, '#f4c25b'];
    const gradOn = h('input', { type: 'checkbox', id: 'gradient-on', 'aria-label': 'Use a name gradient' });
    gradOn.checked = !!me.gradient;
    const g1 = h('input', { type: 'color', id: 'gradient-1', value: g[0], 'aria-label': 'Gradient start colour' });
    const g2 = h('input', { type: 'color', id: 'gradient-2', value: g[1], 'aria-label': 'Gradient end colour' });
    for (const el of [gradOn, g1, g2]) { el.disabled = !premium; el.addEventListener('input', () => renderAvatar()); }
    const gif = h('input', { type: 'file', accept: 'image/gif', id: 'avatar-gif', hidden: true });
    const gifBtn = h('button.btn', { type: 'button', onclick: () => gif.click() }, 'Upload GIF');
    const gifRemove = h('button.btn', { type: 'button' }, 'Remove GIF');
    gifBtn.disabled = gifRemove.disabled = !premium;
    gif.addEventListener('change', async () => {
      const f = gif.files?.[0];
      gif.value = '';
      if (!f) return;
      try {
        if (f.type !== 'image/gif') throw new Error('Animated pictures need to be GIFs.');
        if (f.size > AVATAR_ANIM_MAX_BYTES) throw new Error(`That GIF is too large. Keep it under ${Math.round(AVATAR_ANIM_MAX_BYTES / 1024)} KB.`);
        gifBtn.disabled = true;
        // The GIF plays on your profile and in friends lists; everywhere else uses a small still of its first frame.
        current = await api.uploadAnimatedAvatar(f);
        current = await api.uploadAvatar(await makeAvatar(f));
        showErr('gif', '');
        renderAvatar();
      } catch (ex) { showErr('gif', (ex as Error).message); } finally { gifBtn.disabled = false; }
    });
    gifRemove.addEventListener('click', async () => { current = await api.deleteAnimatedAvatar(); renderAvatar(); });
    const premiumBox = h(`div.field.premium-box${premium ? '' : '.locked'}` as 'div', {},
      h('span.field-label', {}, 'Premium extras ', badges(undefined, true)),
      premium ? null : h('small.muted', {}, 'Available with premium.'),
      h('label.check', {}, gradOn, 'Name gradient', g1, g2, h('span.gradient-preview', {}, namePreview)),
      h('div.row', {}, gifBtn, gifRemove, h('small.muted', {}, `Animated GIF up to ${AVATAR_ANIM_MAX_SIZE} × ${AVATAR_ANIM_MAX_SIZE} px.`)),
      err('gradient'), err('gif'), gif,
    );

    // Favourite colour (no alpha)
    const colorIn = h('input', { type: 'color', id: 'fav-color', value: me.favoriteColor, 'aria-label': 'Favourite colour' });
    const hexIn = h('input', { type: 'text', id: 'fav-hex', value: me.favoriteColor, maxlength: 7, spellcheck: 'false', 'aria-label': 'Favourite colour hex' });
    colorIn.addEventListener('input', () => { hexIn.value = colorIn.value; showErr('favoriteColor', ''); renderAvatar(); });
    hexIn.addEventListener('input', () => {
      const c = normalizeColor(hexIn.value);
      if (c) { colorIn.value = c; showErr('favoriteColor', ''); renderAvatar(); } else showErr('favoriteColor', 'Use 6 hex digits, like #f4c25b (no transparency).');
    });

    // Links (usernames only)
    const linkInputs = new Map<string, HTMLInputElement>();
    const links = h('div.links-grid');
    for (const p of LINK_PLATFORMS) {
      const inp = h('input', { type: 'text', id: 'link-' + p.id, value: me.links[p.id] ?? '', placeholder: p.hint, spellcheck: 'false', autocapitalize: 'off', 'aria-label': p.label });
      linkInputs.set(p.id, inp);
      const e = err('link:' + p.id);
      inp.addEventListener('input', () => showErr('link:' + p.id, normalizeLink(p.id, inp.value) === null ? `That doesn’t look like a ${p.label} ${p.hint}.` : ''));
      links.append(h('label.link-row', {}, h('span.link-label', {}, p.label), h('span.link-input', {}, h('span.at', {}, p.id === 'pixiv' ? '#' : '@'), inp), e));
    }

    const body = h('form.modal-body.profile-form', {},
      setup ? h('p.muted', {}, 'Welcome! This is how other artists will see you in shared rooms. You can change it any time.') : null,
      h('div.profile-top', {},
        avatarBox,
        h('div.profile-top-fields', {},
          h('div.field', {}, h('span.field-label', {}, 'Picture'), h('div.row', {}, upload, remove), h('small.muted', {}, 'Shown small, so it’s resized to 128 × 128.'), err('avatar'), file),
        ),
      ),
      h('div.field', {}, h('label.field-label', { for: 'display-name' }, 'Display name ', counter), nameIn, h('small.muted', {}, 'Anything you like. Letters, numbers, emoji and accents are fine.'), err('displayName')),
      h('div.field', {}, h('label.field-label', { for: 'status' }, 'Status ', statusCount), statusIn, h('small.muted', {}, 'Shown to your friends next to your name.'), err('status')),
      handleField,
      h('div.field', {}, h('label.field-label', { for: 'fav-hex' }, 'Favourite colour'), h('div.row', {}, colorIn, hexIn), h('small.muted', {}, 'Colours your folder and name bubble in rooms.'), err('favoriteColor')),
      premiumBox,
      h('details.field', { open: setup ? null : true }, h('summary.field-label', {}, 'Your other profiles'), h('small.muted', {}, 'Type a username to show a link on your profile. Nothing gets connected.'), links),
      err('form'),
    );
    checkName();
    checkStatus();
    renderAvatar();

    const saveBtn = h('button.btn.primary', { type: 'submit' }, setup ? 'Start drawing' : 'Save');
    const close = modal(setup ? 'Set up your profile' : 'Your profile', body, [saveBtn], () => resolve(saved), !setup);
    const save = async (e?: Event) => {
      e?.preventDefault();
      for (const el of errors.values()) el.textContent = '';
      const linkVals: Record<string, string> = {};
      for (const [k, inp] of linkInputs) linkVals[k] = inp.value;
      saveBtn.disabled = true;
      try {
        saved = await api.updateMe({
          displayName: sanitizeDisplayName(nameIn.value), handle: handle(), favoriteColor: normalizeColor(hexIn.value) ?? colorIn.value,
          links: linkVals, done: true, status: cleanStatus(statusIn.value) ?? statusIn.value,
          ...(premium ? { gradient: gradOn.checked ? [g1.value, g2.value] as [string, string] : null } : {}),
        });
        close();
      } catch (ex) {
        const ae = ex as ApiError;
        showErr(ae.field ?? 'form', ae.message);
        errors.get(ae.field ?? 'form')?.scrollIntoView({ block: 'nearest' });
      } finally { saveBtn.disabled = false; }
    };
    body.addEventListener('submit', save);
    saveBtn.addEventListener('click', save);
  });
}
