import { ApiError, api } from '../net/api';
import {
  AVATAR_ANIM_MAX_BYTES, AVATAR_ANIM_MAX_SIZE, AVATAR_MAX_BYTES, AVATAR_SIZE, DISPLAY_NAME_MAX, STATUS_MAX, cleanStatus, HANDLE_FOODS, HANDLE_WORDS, LINK_PLATFORMS, MyProfile,
  graphemeCount, normalizeColor, normalizeLink, sanitizeDisplayName, splitHandle, validateDisplayName,
} from '../shared/profile';
import { h } from './dom';
import { icon } from './icons';
import { avatarEl, badges, gradientStyle } from './people';
import { modal } from './dialogs';

/** Scale any picture down to a small square (first frame only, so GIFs become static). */
export async function makeAvatar(file: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = c.height = AVATAR_SIZE;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  bmp.close();
  const encode = (type: string, q: number) => new Promise<Blob | null>((r) => c.toBlob(r, type, q));
  for (const q of [0.85, 0.7, 0.5]) {
    let b = await encode('image/webp', q);
    if (!b || b.type !== 'image/webp') b = await encode('image/jpeg', q); // older Safari can't encode WebP
    if (b && b.size <= AVATAR_MAX_BYTES) return b;
  }
  throw new Error('Couldn’t shrink that picture enough. Try a different one.');
}

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
        current = await api.uploadAvatar(await makeAvatar(f));
        showErr('avatar', '');
        renderAvatar();
      } catch (e) { showErr('avatar', (e as Error).message); } finally { upload.disabled = false; }
    });
    remove.addEventListener('click', async () => { current = await api.deleteAvatar(); renderAvatar(); });

    // Handle: <word><food>
    const parts = splitHandle(me.handle) ?? { word: HANDLE_WORDS[0], food: HANDLE_FOODS[0], num: '' };
    let num = parts.num;
    const wordSel = h('select', { id: 'handle-word', 'aria-label': 'Handle word' });
    for (const w of HANDLE_WORDS) wordSel.append(h('option', { value: w }, w));
    const foodSel = h('select', { id: 'handle-food', 'aria-label': 'Handle food' });
    for (const f of HANDLE_FOODS) foodSel.append(h('option', { value: f }, f));
    wordSel.value = parts.word; foodSel.value = parts.food;
    const handlePreview = h('strong.handle-preview');
    const handle = () => wordSel.value + foodSel.value + num;
    const updateHandle = () => { handlePreview.textContent = '@' + handle(); };
    wordSel.addEventListener('change', () => { num = ''; updateHandle(); });
    foodSel.addEventListener('change', () => { num = ''; updateHandle(); });
    const shuffle = h('button.btn', { type: 'button', html: icon('rotate', 16) + '<span>Shuffle</span>' });
    shuffle.addEventListener('click', async () => {
      const { handle: hd } = await api.randomHandle();
      const p = splitHandle(hd);
      if (p) { wordSel.value = p.word; foodSel.value = p.food; num = p.num; updateHandle(); }
    });
    updateHandle();

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
      h('div.field', {}, h('span.field-label', {}, 'Handle ', handlePreview), h('div.row.handle-row', {}, wordSel, foodSel, shuffle), err('handle')),
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
