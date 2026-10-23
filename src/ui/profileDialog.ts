import { ApiError, api } from '../net/api';
import {
  AVATAR_ANIM_MAX_BYTES, DISPLAY_NAME_MAX, HANDLE_MAX, LINK_PLATFORMS, MyProfile, PINNED_MAX, PinnedCanvas,
  graphemeCount, handleError, normalizeLink, sanitizeDisplayName, validateDisplayName,
} from '../shared/profile';
import { cropImage, makeAvatar, makeBanner } from './avatarCrop';
import { h } from './dom';
import { icon } from './icons';
import { HsvField } from './hsvField';
import { avatarEl, badges, gradientStyle, pinImage, pinTile } from './people';
import { modal } from './dialogs';
import { socialLogo } from './socials';

const PERKS = ['Animated GIF picture', 'Name gradient', 'Extra themes', 'Canvases saved to your account', 'Pinned canvases on your card'];

/** Profile setup and editing. Resolves with the saved profile, or null. */
export function profileDialog(me: MyProfile, setup: boolean, patreonLink = false, patreonUrl = ''): Promise<MyProfile | null> {
  return new Promise((resolve) => {
    let current = me;
    let saved: MyProfile | null = null;
    const premium = () => current.premium;
    const errors = new Map<string, HTMLElement>();
    const err = (key: string) => { const e = h('p.field-error', { role: 'alert' }); errors.set(key, e); return e; };
    const showErr = (key: string, msg: string) => { const e = errors.get(key) ?? errors.get('form')!; e.textContent = msg; };
    const guest = me.provider === 'guest';

    // ---- Colour: one picker for the profile colour, or for either end of the gradient ----
    let color = me.favoriteColor;
    const g: [string, string] = me.gradient ?? [me.favoriteColor, '#f4c25b'];
    let end: 0 | 1 = 0;
    const gradOn = h('input', { type: 'checkbox', id: 'gradient-on' });
    gradOn.checked = !!me.gradient;
    const namePreview = h('span.name-preview');
    const picker = new HsvField(color, (hex) => { if (gradOn.checked) g[end] = hex; else color = hex; renderColor(); });
    const colorPop = h('div.popover.swatch-pop', { hidden: true }, h('div.panel', {}, picker.el));
    // Click a swatch to open the picker for it.
    const swatches = [0, 1].map((i) => h('button.gswatch', { type: 'button', 'aria-label': i ? 'Gradient end' : 'Profile colour', onclick: () => {
      end = i as 0 | 1;
      colorPop.hidden = !colorPop.hidden && colorPop.dataset.for === String(i);
      colorPop.dataset.for = String(i);
      picker.set(gradOn.checked ? g[end] : color);
      colorPop.style.top = `${swatches[i].offsetTop + swatches[i].offsetHeight + 6}px`;
      colorPop.style.left = `${swatches[i].offsetLeft}px`;
      renderColor();
    } }));
    const gradient = (): [string, string] | null => (gradOn.checked && premium() ? [...g] as [string, string] : null);
    const renderColor = () => {
      const gr = gradient();
      gradOn.disabled = !premium();
      swatches[1].hidden = !gr;
      swatches[0].style.background = gr ? g[0] : color;
      swatches[1].style.background = g[1];
      swatches.forEach((s, i) => s.classList.toggle('active', !colorPop.hidden && end === i));
      namePreview.textContent = sanitizeDisplayName(nameIn.value) || current.displayName;
      namePreview.className = gr ? 'name-preview gradient-name' : 'name-preview';
      namePreview.setAttribute('style', gr ? gradientStyle(gr) : `color:${color}`);
      renderAvatar();
    };
    gradOn.addEventListener('change', () => { end = 0; colorPop.hidden = true; renderColor(); });
    const colorField = h('div.field.color-field', {},
      h('div.field-label', {}, 'Profile colour', h('label.check', { title: premium() ? '' : 'Part of premium' }, gradOn, 'Gradient')),
      namePreview, h('div.gswatches', {}, ...swatches), colorPop, err('favoriteColor'), err('gradient'));

    // ---- Picture and banner ----
    const file = h('input', { type: 'file', id: 'avatar-file', hidden: true });
    const bannerFile = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', id: 'banner-file', hidden: true });
    const overlay = () => h('span.pic-overlay', { html: icon('camera', 26) });
    const avatarBox = h('button.avatar-edit', { type: 'button', title: 'Change picture', 'aria-label': 'Change picture', onclick: () => { file.accept = 'image/png,image/jpeg,image/webp' + (premium() ? ',image/gif' : ''); file.click(); } });
    const bannerBox = h('button.banner-edit', { type: 'button', title: 'Change banner', 'aria-label': 'Change banner', onclick: () => bannerFile.click() }, overlay());
    const remove = h('button.link-btn', { type: 'button', onclick: async () => { current = await api.deleteAvatar(); renderAvatar(); } }, 'Remove picture');
    const removeBanner = h('button.link-btn', { type: 'button', onclick: async () => { current = await api.deleteBanner(); renderAvatar(); } }, 'Remove banner');
    const renderAvatar = () => {
      avatarBox.replaceChildren(avatarEl({ ...current, displayName: nameIn.value || current.displayName, favoriteColor: color, gradient: gradient() }, 96, true), overlay());
      bannerBox.style.backgroundImage = current.banner ? `url(${current.banner})` : '';
      bannerBox.classList.toggle('has-banner', !!current.banner);
      removeBanner.hidden = !current.banner;
      remove.hidden = !current.avatar;
    };
    const pick = async (input: HTMLInputElement, key: string, run: (f: File) => Promise<void>) => {
      const f = input.files?.[0];
      input.value = '';
      if (!f) return;
      try { await run(f); showErr(key, ''); renderAvatar(); } catch (e) { showErr(key, (e as Error).message); }
    };
    file.addEventListener('change', () => pick(file, 'avatar', async (f) => {
      const gif = f.type === 'image/gif';
      if (gif && !premium()) throw new Error('GIF pictures are part of premium.');
      if (gif && f.size > AVATAR_ANIM_MAX_BYTES) throw new Error(`Keep GIFs under ${Math.round(AVATAR_ANIM_MAX_BYTES / 1048576)} MB.`);
      const crop = await cropImage(f);
      if (!crop) return;
      // The still goes first (it replaces any GIF); a GIF can't be re-encoded here, so it follows whole with its crop.
      current = await api.uploadAvatar(await makeAvatar(f, crop));
      if (gif) current = await api.uploadAnimatedAvatar(f, { x: crop.x / crop.w, y: crop.y / crop.w, w: crop.srcW / crop.w, h: crop.srcH / crop.w });
    }));
    bannerFile.addEventListener('change', () => pick(bannerFile, 'avatar', async (f) => {
      const crop = await cropImage(f, 3, 'Crop your banner');
      if (crop) current = await api.uploadBanner(await makeBanner(f, crop));
    }));

    // ---- Handle ----
    const handleIn = h('input', { type: 'text', id: 'handle', value: me.handle, maxlength: HANDLE_MAX, spellcheck: 'false', autocapitalize: 'off', autocomplete: 'username', 'aria-label': 'Handle' });
    const handleState = h('small.handle-state', { 'aria-live': 'polite' });
    let checkTimer = 0, checkSeq = 0;
    const setState = (kind: '' | 'ok' | 'bad' | 'wait', text: string) => { handleState.className = 'handle-state ' + kind; handleState.textContent = text; };
    const checkHandle = () => {
      clearTimeout(checkTimer);
      const v = handleIn.value.trim().replace(/^@/, '');
      if (v.toLowerCase() === current.handle.toLowerCase()) { setState('', ''); return; }
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
    // Locked after setup so it isn't changed by accident; the pencil unlocks it.
    handleIn.readOnly = guest || !setup;
    const pencil = h('button.icon-btn', { type: 'button', title: 'Change handle', 'aria-label': 'Change handle', html: icon('pencil', 18), onclick: () => { handleIn.readOnly = false; pencil.hidden = true; handleIn.focus(); } });
    pencil.hidden = guest || setup;
    const handle = () => handleIn.value.trim().replace(/^@/, '');
    const handleField = h('div.field', {},
      h('label.field-label', { for: 'handle' }, 'Handle'),
      h('div.row.handle-row', {}, h('span.handle-input', {}, h('span.at', {}, '@'), handleIn), guest ? shuffle : pencil),
      guest ? h('small.muted', {}, 'Log in with Discord to choose your own handle.') : handleState,
      err('handle'),
    );

    const nameIn = h('input', { type: 'text', id: 'display-name', value: me.displayName, maxlength: DISPLAY_NAME_MAX * 2, autocomplete: 'nickname', 'aria-label': 'Display name' });
    const counter = h('span.counter');
    const checkName = () => {
      const clean = sanitizeDisplayName(nameIn.value);
      counter.textContent = `${graphemeCount(clean)}/${DISPLAY_NAME_MAX}`;
      showErr('displayName', nameIn.value.trim() ? validateDisplayName(clean) ?? '' : '');
      renderColor();
    };
    nameIn.addEventListener('input', checkName);

    // ---- Premium: what it unlocks, and the Patreon link that grants it ----
    const premiumBox = h('div.field.premium-box');
    const perks = h('ul.perks', {}, ...PERKS.map((t) => h('li', {}, h('span', { html: icon('check', 14) }), t)));
    const linkBtn = () => h('a.btn', { href: '/auth/patreon?next=' + encodeURIComponent(location.pathname + location.search) }, 'Link Patreon');
    const renderPremium = async (action?: () => Promise<MyProfile>) => {
      if (action) { try { current = await action(); } catch (e) { showErr('form', (e as Error).message); } }
      const pt = current.patreon;
      const head = h('span.field-label', {}, 'Premium ', badges(undefined, true));
      const checkAgain = h('button.btn', { type: 'button', onclick: () => renderPremium(api.checkPatreon) }, 'Check again');
      const unlink = h('button.btn', { type: 'button', onclick: () => renderPremium(api.unlinkPatreon) }, 'Unlink');
      premiumBox.classList.toggle('locked', !premium() && !pt);
      if (premium()) {
        const until = current.premiumUntil ? `until ${new Date(current.premiumUntil).toLocaleDateString()}` : '';
        premiumBox.replaceChildren(head,
          h('small.muted', {}, pt ? `Linked as ${pt.name}${pt.active ? ' · active patron' : ` · ${until || 'granted'}`}` : until || 'Granted to your account'),
          perks, h('div.row', {}, ...(pt ? [checkAgain, unlink] : patreonLink ? [linkBtn()] : [])));
      } else if (pt) {
        premiumBox.replaceChildren(head, h('small.muted', {}, `Linked as ${pt.name} · not an active patron`),
          h('div.row.center', {}, checkAgain, unlink));
      } else {
        premiumBox.replaceChildren(head, perks, h('div.premium-lock', {},
          socialLogo('patreon', 40), h('span', {}, 'Link Patreon for these perks'),
          h('div.row', {}, patreonLink ? linkBtn() : null, patreonUrl ? h('a.btn', { href: patreonUrl, target: '_blank', rel: 'noopener noreferrer' }, 'See Patreon') : null)));
      }
      renderColor();
    };
    premiumBox.hidden = setup || guest;

    // ---- Socials ----
    const links: Record<string, string> = { ...me.links };
    const socials = h('div.social-list');
    const socialPicker = h('div.social-picker', { hidden: true });
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
        socialPicker.hidden = true;
        renderSocials();
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
      socialPicker.replaceChildren(h('div.social-ask', {},
        socialLogo(p.id, 32),
        h('span.handle-input', {}, h('span.at', {}, p.id === 'pixiv' ? '#' : '@'), inp),
        h('button.btn', { type: 'button', onclick: add }, 'Add'),
        h('button.icon-btn', { type: 'button', title: 'Cancel', html: icon('x', 16), onclick: () => { socialPicker.hidden = true; showErr('links', ''); } }),
      ));
      inp.focus();
    };
    addSocial.addEventListener('click', () => {
      socialPicker.replaceChildren(h('div.social-choices', {}, ...LINK_PLATFORMS.filter((p) => !links[p.id]).map((p) =>
        h('button.social-choice', { type: 'button', title: p.label, 'aria-label': p.label, onclick: () => askUsername(p) }, socialLogo(p.id, 36)))));
      socialPicker.hidden = !socialPicker.hidden;
    });
    renderSocials();

    // ---- Pinned canvases: up to PINNED_MAX of the person's own saved canvases, shown on their card ----
    const known = new Map<string, PinnedCanvas>(me.pinned.map((c) => [c.id, c]));
    let pinned = me.pinned.map((c) => c.id);
    const pins = h('div.pin-list');
    const pinPicker = h('div.pin-picker', { hidden: true });
    const addPin = h('button.social-add', { type: 'button', title: 'Pin a canvas', 'aria-label': 'Pin a canvas', html: icon('plus', 18) });
    const renderPins = () => {
      pins.replaceChildren(...pinned.map((id) => { const c = known.get(id)!; return h('span.pin-chip', { title: c.name }, pinImage(c),
        h('button.icon-btn', { type: 'button', title: `Unpin ${c.name}`, 'aria-label': `Unpin ${c.name}`, html: icon('x', 14), onclick: () => { pinned = pinned.filter((x) => x !== id); renderPins(); } })); }), addPin);
      addPin.hidden = pinned.length >= PINNED_MAX;
      pinPicker.hidden = true;
    };
    addPin.addEventListener('click', async () => {
      if (!pinPicker.hidden) { pinPicker.hidden = true; return; }
      const choices = (await api.projects()).filter((c) => !c.private && !pinned.includes(c.id)).map((c): PinnedCanvas => ({ id: c.id, name: c.name, thumb: c.thumb }));
      for (const c of choices) known.set(c.id, c);
      pinPicker.replaceChildren(choices.length ? h('div.pin-choices', {}, ...choices.map((c) => pinTile(c, () => { pinned.push(c.id); renderPins(); })))
        : h('small.muted', {}, 'Canvases saved to your account can be pinned. Private ones stay off your card.'));
      pinPicker.hidden = false;
    });
    renderPins();

    const body = h('form.modal-body.profile-form', {},
      h('div.field', {},
        h('div.profile-pics', {}, bannerBox, avatarBox),
        h('small.muted.pic-hint', {}, 'PNG, JPG or WebP. GIF pictures with premium. ', remove, removeBanner), err('avatar'), file, bannerFile),
      h('div.field', {}, h('label.field-label', { for: 'display-name' }, 'Display name ', counter), nameIn, err('displayName')),
      handleField,
      colorField,
      premiumBox,
      h('div.field', {}, h('span.field-label', {}, 'Socials'), socials, socialPicker, err('links')),
      setup ? null : h('div.field', {}, h('span.field-label', {}, `Pinned canvases (${PINNED_MAX} max)`), pins, pinPicker, err('pinned')),
      err('form'),
    );
    body.addEventListener('pointerdown', (e) => { const t = e.target as Node; if (!colorPop.contains(t) && !swatches.some((b) => b.contains(t))) { colorPop.hidden = true; renderColor(); } });
    checkName();
    void renderPremium();

    const saveBtn = h('button.btn.primary', { type: 'submit' }, setup ? 'Start drawing' : 'Save');
    const close = modal(setup ? 'Set up your profile' : 'Your profile', body, [saveBtn], () => resolve(saved), !setup);
    const save = async (e?: Event) => {
      e?.preventDefault();
      for (const el of errors.values()) el.textContent = '';
      saveBtn.disabled = true;
      try {
        saved = await api.updateMe({
          displayName: sanitizeDisplayName(nameIn.value), handle: handle(), favoriteColor: color,
          links: Object.fromEntries(LINK_PLATFORMS.map((p) => [p.id, links[p.id] ?? ''])), done: true, ...(setup ? {} : { pinned }),
          ...(premium() ? { gradient: gradient() } : {}),
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
