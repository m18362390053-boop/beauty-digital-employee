const svgNamespace = 'http://www.w3.org/2000/svg';

const highlights = {
  full_face: [['path', { d: 'M98 116 Q170 84 242 116 Q258 163 247 236 Q234 309 170 344 Q106 309 93 236 Q82 163 98 116 Z M91 184 Q117 198 145 184 L145 210 Q117 221 91 210 Z M195 184 Q223 198 249 184 L249 210 Q223 221 195 210 Z M130 282 Q170 272 210 282 L210 316 Q170 324 130 316 Z', 'fill-rule': 'evenodd' }]],
  under_eye: [
    ['path', { d: 'M94 201 Q117 211 143 200 L141 216 Q117 224 96 214 Z' }],
    ['path', { d: 'M197 200 Q223 211 246 201 L244 214 Q223 224 199 216 Z' }],
  ],
  forehead: [['path', { d: 'M101 93 Q170 69 239 93 L235 139 Q170 127 105 139 Z' }]],
  cheek: [
    ['path', { d: 'M76 225 Q101 209 138 224 L139 268 Q117 292 86 280 Z' }],
    ['path', { d: 'M202 224 Q239 209 264 225 L254 280 Q223 292 201 268 Z' }],
  ],
  nose: [['path', { d: 'M155 155 L185 155 L194 249 Q170 262 146 249 Z' }]],
  chin: [['path', { d: 'M125 301 Q170 314 215 301 Q204 341 170 346 Q136 341 125 301 Z' }]],
  t_zone: [
    ['path', { d: 'M104 94 Q170 72 236 94 L231 139 Q170 128 109 139 Z' }],
    ['path', { d: 'M151 132 L189 132 L190 241 Q184 254 170 255 Q156 254 150 241 Z' }],
  ],
  nasolabial_fold: [
    ['path', { d: 'M139 250 C128 258 122 273 120 289', class: 'face-fold-highlight' }],
    ['path', { d: 'M201 250 C212 258 218 273 220 289', class: 'face-fold-highlight' }],
  ],
  flaky_area: [
    ['ellipse', { cx: '132', cy: '250', rx: '17', ry: '13' }],
    ['ellipse', { cx: '208', cy: '250', rx: '17', ry: '13' }],
    ['ellipse', { cx: '170', cy: '319', rx: '27', ry: '15' }],
  ],
};

function svgNode(parent, name, attributes = {}) {
  const node = document.createElementNS(svgNamespace, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  parent.append(node);
  return node;
}

function textNode(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function portrait(svg, region) {
  svgNode(svg, 'path', { d: 'M95 356 Q63 373 48 399 L292 399 Q277 373 245 356 Z', class: 'portrait-shoulders' });
  svgNode(svg, 'path', { d: 'M145 328 L145 367 Q170 387 195 367 L195 328 Z', class: 'portrait-neck' });
  svgNode(svg, 'path', { d: 'M63 212 C36 164 46 87 91 53 Q129 18 170 32 Q226 10 265 66 C303 106 301 176 278 218 L269 306 Q256 349 237 363 L240 169 L100 169 L102 363 Q80 347 72 299 Z', class: 'portrait-hair' });
  svgNode(svg, 'ellipse', { cx: '69', cy: '223', rx: '13', ry: '27', class: 'portrait-ear' });
  svgNode(svg, 'ellipse', { cx: '271', cy: '223', rx: '13', ry: '27', class: 'portrait-ear' });
  svgNode(svg, 'path', { d: 'M170 58 C111 58 75 104 75 181 C75 275 110 350 170 361 C230 350 265 275 265 181 C265 104 229 58 170 58 Z', class: 'portrait-face' });
  for (const [name, attributes] of highlights[region]) svgNode(svg, name, { ...attributes, class: `face-highlight ${attributes.class ?? ''}`.trim() });
  svgNode(svg, 'path', { d: 'M72 165 Q67 100 105 74 Q140 45 171 61 Q205 42 240 78 Q276 112 267 165 Q257 128 238 101 Q208 110 182 88 Q148 113 107 103 Q86 124 72 165 Z', class: 'portrait-hair-front' });
  svgNode(svg, 'path', { d: 'M92 159 Q115 144 143 156 M197 156 Q225 144 248 159', class: 'portrait-brows' });
  svgNode(svg, 'path', { d: 'M91 190 Q117 208 143 190 M197 190 Q223 208 249 190', class: 'portrait-eye-line' });
  svgNode(svg, 'path', { d: 'M98 194 L94 202 M106 199 L103 207 M134 198 L137 207 M142 193 L146 201 M204 193 L200 201 M212 198 L209 207 M239 199 L242 207 M247 194 L251 202', class: 'portrait-lashes' });
  svgNode(svg, 'path', { d: 'M170 180 Q166 214 162 239 Q170 245 178 239', class: 'portrait-nose' });
  svgNode(svg, 'path', { d: 'M161 243 Q164 246 168 244 M172 244 Q176 246 179 243', class: 'portrait-nostril' });
  svgNode(svg, 'path', { d: 'M136 293 Q151 287 169 290 Q188 287 204 293 Q189 309 170 309 Q151 309 136 293 Z', class: 'portrait-lips' });
  svgNode(svg, 'path', { d: 'M139 294 Q170 300 201 294', class: 'portrait-mouth-line' });
  if (region === 'under_eye') {
    svgNode(svg, 'path', { d: 'M94 226 Q117 235 143 226 M197 226 Q223 235 246 226', class: 'face-application-boundary' });
  }
}

export function renderFaceGuide(guide) {
  if (!Object.hasOwn(highlights, guide.region)) return null;
  const card = textNode('section', '', 'face-guide');
  card.dataset.region = guide.region;
  card.setAttribute('aria-label', guide.title);
  card.append(textNode('h3', guide.title));
  const figure = document.createElement('figure');
  figure.className = 'face-figure';
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.setAttribute('viewBox', '0 0 340 400');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${guide.title}。${guide.location}`);
  portrait(svg, guide.region);
  figure.append(svg, textNode('figcaption', '高亮处是示意位置，并非对您面部的判断。'));
  card.append(figure);
  if (guide.region === 'under_eye') card.append(textNode('p', '蓝色虚线是眼周外围参照，不是按摩路线。', 'face-figure-note'));
  const details = document.createElement('div'); details.className = 'face-guide-details';
  for (const [label, value] of [['在哪里', guide.location], ['怎么涂', guide.application], ['请注意', guide.caution]]) {
    const line = document.createElement('p');
    line.append(textNode('strong', label), textNode('span', value));
    details.append(line);
  }
  card.append(details);
  const toggle = textNode('button', '暂停高亮'); toggle.type = 'button';
  toggle.addEventListener('click', () => {
    const paused = card.classList.toggle('paused');
    toggle.textContent = paused ? '播放高亮' : '暂停高亮';
    toggle.setAttribute('aria-pressed', String(paused));
  });
  toggle.setAttribute('aria-pressed', 'false');
  card.append(toggle);
  return card;
}
