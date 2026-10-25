// Discord-style shortcodes: :smile: and friends. Typed in chat, they become the character before sending.

export const EMOJI: Record<string, string> = {
  smile: '😄', grinning: '😀', grin: '😁', joy: '😂', rofl: '🤣', sweat_smile: '😅', laughing: '😆', wink: '😉', blush: '😊', innocent: '😇',
  slight_smile: '🙂', upside_down: '🙃', relaxed: '☺️', yum: '😋', relieved: '😌', heart_eyes: '😍', kissing_heart: '😘', kissing: '😗', star_struck: '🤩',
  stuck_out_tongue: '😛', stuck_out_tongue_winking_eye: '😜', zany: '🤪', stuck_out_tongue_closed_eyes: '😝', money_mouth: '🤑', hugging: '🤗',
  thinking: '🤔', shushing: '🤫', zipper_mouth: '🤐', neutral_face: '😐', expressionless: '😑', no_mouth: '😶', smirk: '😏', unamused: '😒',
  rolling_eyes: '🙄', grimacing: '😬', lying_face: '🤥', pensive: '😔', sleepy: '😪', drooling: '🤤', sleeping: '😴', mask: '😷', thermometer_face: '🤒',
  nauseated: '🤢', sneezing: '🤧', hot: '🥵', cold: '🥶', woozy: '🥴', dizzy_face: '😵', exploding_head: '🤯', cowboy: '🤠', partying: '🥳',
  sunglasses: '😎', nerd: '🤓', monocle: '🧐', confused: '😕', worried: '😟', slight_frown: '🙁', frowning: '☹️', open_mouth: '😮', hushed: '😯',
  astonished: '😲', flushed: '😳', pleading: '🥺', frowning2: '😦', anguished: '😧', fearful: '😨', cold_sweat: '😰', disappointed_relieved: '😥',
  cry: '😢', sob: '😭', scream: '😱', confounded: '😖', persevere: '😣', disappointed: '😞', sweat: '😓', weary: '😩', tired_face: '😫', yawning: '🥱',
  triumph: '😤', rage: '😡', angry: '😠', cursing: '🤬', smiling_imp: '😈', imp: '👿', skull: '💀', poop: '💩', clown: '🤡', ghost: '👻', alien: '👽',
  robot: '🤖', heart: '❤️', orange_heart: '🧡', yellow_heart: '💛', green_heart: '💚', blue_heart: '💙', purple_heart: '💜', black_heart: '🖤',
  broken_heart: '💔', two_hearts: '💕', sparkling_heart: '💖', heartpulse: '💗', revolving_hearts: '💞', kiss: '💋', fire: '🔥', sparkles: '✨',
  star: '⭐', star2: '🌟', zap: '⚡', boom: '💥', dizzy: '💫', sweat_drops: '💦', dash: '💨', hundred: '💯', ok_hand: '👌', thumbsup: '👍',
  thumbsdown: '👎', clap: '👏', raised_hands: '🙌', pray: '🙏', wave: '👋', muscle: '💪', point_up: '☝️', point_right: '👉', point_left: '👈',
  v: '✌️', crossed_fingers: '🤞', metal: '🤘', call_me: '🤙', punch: '👊', fist: '✊', handshake: '🤝', writing_hand: '✍️', eyes: '👀', eye: '👁️',
  brain: '🧠', tongue: '👅', art: '🎨', paintbrush: '🖌️', crayon: '🖍️', pencil2: '✏️', pencil: '📝', bee: '🐝', honey_pot: '🍯', rainbow: '🌈',
  sun: '☀️', sunny: '☀️', moon: '🌙', cloud: '☁️', snowflake: '❄️', cherry_blossom: '🌸', rose: '🌹', sunflower: '🌻', four_leaf_clover: '🍀',
  cat: '🐱', dog: '🐶', fox: '🦊', frog: '🐸', bird: '🐦', butterfly: '🦋', unicorn: '🦄', dragon: '🐉', snail: '🐌', octopus: '🐙',
  coffee: '☕', tea: '🍵', pizza: '🍕', cake: '🍰', cookie: '🍪', doughnut: '🍩', apple: '🍎', strawberry: '🍓', beer: '🍺', wine_glass: '🍷',
  tada: '🎉', confetti_ball: '🎊', balloon: '🎈', gift: '🎁', trophy: '🏆', medal: '🏅', crown: '👑', gem: '💎', bulb: '💡', rocket: '🚀',
  hourglass: '⌛', alarm_clock: '⏰', eyeglasses: '👓', musical_note: '🎵', notes: '🎶', video_game: '🎮', dart: '🎯', camera: '📷',
  heavy_check_mark: '✔️', white_check_mark: '✅', x: '❌', question: '❓', exclamation: '❗', warning: '⚠️', no_entry: '⛔', recycle: '♻️',
  arrow_right: '➡️', arrow_left: '⬅️', arrow_up: '⬆️', arrow_down: '⬇️', plus: '➕', zzz: '💤', wave_hand: '👋', salute: '🫡', melting: '🫠',
  shrug: '🤷', facepalm: '🤦', dancer: '💃', man_dancing: '🕺', person_raising_hand: '🙋', bow: '🙇',
};

const NAMES = Object.keys(EMOJI);

/** Shortcode names starting with (then containing) the typed part. */
export function emojiMatches(q: string, max = 8): string[] {
  const s = q.toLowerCase();
  const starts = NAMES.filter((n) => n.startsWith(s)), within = NAMES.filter((n) => !n.startsWith(s) && n.includes(s));
  return [...starts, ...within].slice(0, max);
}

/** :smile: → 😄 for every code in the table; unknown codes stay as typed. */
export function emojify(text: string): string {
  return text.replace(/:([a-z0-9_+-]+):/gi, (m, name: string) => EMOJI[name.toLowerCase()] ?? m);
}
