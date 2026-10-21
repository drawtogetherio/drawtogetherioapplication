import { ApiError, api } from '../net/api';
import {
  AVATAR_ANIM_MAX_BYTES, AVATAR_ANIM_MAX_SIZE, DISPLAY_NAME_MAX, HANDLE_MAX, LINK_PLATFORMS, MyProfile,
  graphemeCount, handleError, normalizeColor, normalizeLink, sanitizeDisplayName, validateDisplayName,
} from '../shared/profile';
import { cropAvatar, makeAvatar } from './avatarCrop';
import { h } from './dom';
import { icon } from './icons';
import { avatarEl, badges, gradientStyle } from './people';
import { modal } from './dialogs';
import { socialLogo } from './socials';

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
    const handleField = h('div.field', {},
      h('label.field-label', { for: 'handle' }, 'Handle'),
      h('div.row.handle-row', {}, h('span.handle-input', {}, h('span.at', {}, '@'), handleIn), guest ? shuffle : null),
      guest ? h('small.muted', {}, 'Log in with Discord to choose your own handle.') : handleState,
      err('handle'),
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

    // Premium: name gradient and animated picture
    const premium = me.premium;
    const g = me.gradient ?? [me.favoriteColor, '#f4c25b'];
    const gradOn = h('input', { type: 'checkbox', id: 'gradient-on', 'aria-label': 'Use a name gradient' });
    gradOn.checked = !!me.gradient;
    const g1 = h('input', { type: 'color', id: 'gradient-1', value: g[0], 'aria-label': 'Gradient start colour' });
    const g2 = h('input', { type: 'color', id: 'gradient-2', value: g[1], 'aria-label': 'Gradient end colour' });
    for (const el of [gradOn, g1, g2]) { el.disabled = !premium; el.addEventListener('input', () => renderAvatar()); }
    const gif = h('input', { type: 'file', accept: 'image/gif', id: 'avatar-gif', hidden: true });
    const gifBtn = h('button.btn', { type: 'button', title: `GIF up to ${AVATAR_ANIM_MAX_SIZE} × ${AVATAR_ANIM_MAX_SIZE} px`, onclick: () => gif.click() }, 'Upload GIF');
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
        // The GIF plays on your profile and in friends lists; everywhere else uses a still of its first frame.
        current = await api.uploadAnimatedAvatar(f);
        current = await api.uploadAvatar(await makeAvatar(f));
        showErr('gif', '');
        renderAvatar();
      } catch (ex) { showErr('gif', (ex as Error).message); } finally { gifBtn.disabled = false; }
    });
    gifRemove.addEventListener('click', async () => { current = await api.deleteAnimatedAvatar(); renderAvatar(); });
    const premiumBox = h(`div.field.premium-box${premium ? '' : '.locked'}` as 'div', {},
      h('span.field-label', {}, 'Premium ', badges(undefined, true)),
      h('label.check', {}, gradOn, 'Name gradient', g1, g2, h('span.gradient-preview', {}, namePreview)),
      h('div.row', {}, gifBtn, gifRemove),
      err('gradient'), err('gif'), gif,
    );

    // Profile colour (no alpha)
    const colorIn = h('input', { type: 'color', id: 'fav-color', value: me.favoriteColor, 'aria-label': 'Profile colour' });
    const hexIn = h('input', { type: 'text', id: 'fav-hex', value: me.favoriteColor, maxlength: 7, spellcheck: 'false', 'aria-label': 'Profile colour hex' });
    colorIn.addEventListener('input', () => { hexIn.value = colorIn.value; showErr('favoriteColor', ''); renderAvatar(); });
    hexIn.addEventListener('input', () => {
      const c = normalizeColor(hexIn.value);
      if (c) { colorIn.value = c; showErr('favoriteColor', ''); renderAvatar(); } else showErr('favoriteColor', 'Use 6 hex digits, like #f4c25b.');
    });

    // Socials: the ones you've added, plus a + that opens a picker of the rest.
    const links: Record<string, string> = { ...me.links };
    const socials = h('div.social-list');
    const picker = h('div.social-picker', { hidden: true });
    const addSocial = h('button.social-add', { type: 'button', title: 'Add a social', 'aria-label': 'Add a social', html: icon('plus', 18) });
    const renderSocials = () => {
      socials.replaceChildren(...LINK_PLATFORMS.filter((p) => links[p.id]).map((p) => h('span.social-chip', {},
        socialLogo(p.id, 22),
        h('span', {}, (p.id === 'pixiv' ? '#' : '@') + links[p.id]),
        h('button.icon-btn', { type: 'button', title: `Remove ${p.label}`, html: icon('x', 14), onclick: () => { delete links[p.id]; renderSocials(); } }),
      )), addSocial);
      addSocial.hidden = LINK_PLATFORMS.every((p) => links[p.id]);
    };
    const askUsername = (p: typeof LINK_PLATFORMS[number]) => {
      const inp = h('input', { type: 'text', id: 'link-' + p.id, placeholder: p.hint, spellcheck: 'false', autocapitalize: 'off', 'aria-label': `${p.label} ${p.hint}` });
      const add = () => {
        const v = normalizeLink(p.id, inp.value);
        if (!v) { showErr('links', `That doesn’t look like a ${p.label} ${p.hint}.`); return; }
        links[p.id] = v;
        showErr('links', '');
        picker.hidden = true;
        renderSocials();
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
      picker.replaceChildren(h('div.social-ask', {},
        socialLogo(p.id, 32),
        h('span.handle-input', {}, h('span.at', {}, p.id === 'pixiv' ? '#' : '@'), inp),
        h('button.btn', { type: 'button', onclick: add }, 'Add'),
        h('button.icon-btn', { type: 'button', title: 'Cancel', html: icon('x', 16), onclick: () => { picker.hidden = true; showErr('links', ''); } }),
      ));
      inp.focus();
    };
    addSocial.addEventListener('click', () => {
      picker.replaceChildren(h('div.social-choices', {}, ...LINK_PLATFORMS.filter((p) => !links[p.id]).map((p) =>
        h('button.social-choice', { type: 'button', title: p.label, 'aria-label': p.label, onclick: () => askUsername(p) }, socialLogo(p.id, 36)))));
      picker.hidden = !picker.hidden;
    });
    renderSocials();

    const body = h('form.modal-body.profile-form', {},
      h('div.profile-top', {},
        avatarBox,
        h('div.profile-top-fields', {},
          h('div.field', {}, h('span.field-label', {}, 'Picture'), h('div.row', {}, upload, remove), err('avatar'), file),
        ),
      ),
      h('div.field', {}, h('label.field-label', { for: 'display-name' }, 'Display name ', counter), nameIn, err('displayName')),
      handleField,
      h('div.field', {}, h('label.field-label', { for: 'fav-hex' }, 'Profile colour'), h('div.row', {}, colorIn, hexIn), err('favoriteColor')),
      premiumBox,
      h('div.field', {}, h('span.field-label', {}, 'Socials'), socials, picker, err('links')),
      err('form'),
    );
    checkName();
    renderAvatar();

    const saveBtn = h('button.btn.primary', { type: 'submit' }, setup ? 'Start drawing' : 'Save');
    const close = modal(setup ? 'Set up your profile' : 'Your profile', body, [saveBtn], () => resolve(saved), !setup);
    const save = async (e?: Event) => {
      e?.preventDefault();
      for (const el of errors.values()) el.textContent = '';
      saveBtn.disabled = true;
      try {
        saved = await api.updateMe({
          displayName: sanitizeDisplayName(nameIn.value), handle: handle(), favoriteColor: normalizeColor(hexIn.value) ?? colorIn.value,
          links: Object.fromEntries(LINK_PLATFORMS.map((p) => [p.id, links[p.id] ?? ''])), done: true,
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
