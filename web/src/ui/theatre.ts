/** Static vector cloth: curved fold surfaces and a small, repeatable fibre pattern. */
function fabricGrain() {
  let seed = 9271;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const threads = (count: number) => Array.from({ length: count }, () => {
    const x = (random() * 96).toFixed(1), y = (random() * 96).toFixed(1);
    return `M${x} ${y}l${(.3 + random() * 1.5).toFixed(1)} ${(.3 + random() * .8).toFixed(1)}`;
  }).join('');
  return `<pattern id="velvet-grain" width="96" height="96" patternUnits="userSpaceOnUse"><path d="${threads(360)}" fill="none" stroke="#e1c3dc" stroke-width=".65" opacity=".14"/><path d="${threads(300)}" fill="none" stroke="#090917" stroke-width=".75" opacity=".24"/></pattern>`;
}

function backdrop() {
  // Uneven fold spacing and curved edges avoid the appearance of striped wallpaper.
  const folds = [
    [0, 142, 25], [118, 128, -13], [228, 174, 21], [376, 131, -19],
    [491, 156, 11], [630, 119, -9], [735, 160, 18], [877, 133, -23],
    [996, 170, 15], [1145, 127, -13], [1255, 185, 26],
  ];
  const panels = folds.map(([x, w, bend], i) => {
    const end = x + w;
    return `<path d="M${x} 0H${end}C${end + bend} 290 ${end - bend} 730 ${end + bend * .3} 1000H${x - bend * .4}C${x - bend} 700 ${x + bend} 290 ${x} 0Z" fill="url(#back-fold-${i % 3})"/>`;
  }).join('');
  return `<svg class="theatre-backdrop" viewBox="0 0 1440 1000" preserveAspectRatio="none">
    <defs>${fabricGrain()}
      <linearGradient id="back-fold-0"><stop stop-color="#120e27" stop-opacity="0"/><stop offset=".1" stop-color="#22132f" stop-opacity=".32"/><stop offset=".23" stop-color="#2a1734" stop-opacity=".18"/><stop offset=".46" stop-color="#d49fbd" stop-opacity=".2"/><stop offset=".62" stop-color="#b974a1" stop-opacity=".12"/><stop offset=".88" stop-color="#381b3d" stop-opacity=".14"/><stop offset="1" stop-color="#1a1029" stop-opacity="0"/></linearGradient>
      <linearGradient id="back-fold-1"><stop stop-color="#1b122d" stop-opacity="0"/><stop offset=".15" stop-color="#241431" stop-opacity=".29"/><stop offset=".33" stop-color="#3d213e" stop-opacity=".08"/><stop offset=".58" stop-color="#dca7c4" stop-opacity=".16"/><stop offset=".72" stop-color="#bc85ae" stop-opacity=".19"/><stop offset=".91" stop-color="#321736" stop-opacity=".1"/><stop offset="1" stop-color="#190e28" stop-opacity="0"/></linearGradient>
      <linearGradient id="back-fold-2"><stop stop-color="#21132e" stop-opacity="0"/><stop offset=".12" stop-color="#24132f" stop-opacity=".34"/><stop offset=".27" stop-color="#3d203f" stop-opacity=".1"/><stop offset=".49" stop-color="#cd8eb5" stop-opacity=".23"/><stop offset=".69" stop-color="#b580aa" stop-opacity=".08"/><stop offset=".88" stop-color="#28152e" stop-opacity=".16"/><stop offset="1" stop-color="#180f28" stop-opacity="0"/></linearGradient>
      <radialGradient id="stage-spot" cx=".49" cy=".4" r=".64" gradientTransform="translate(0 -.12) scale(1 1.25)"><stop stop-color="#d395b9" stop-opacity=".28"/><stop offset=".38" stop-color="#b4669b" stop-opacity=".13"/><stop offset=".78" stop-color="#26142f" stop-opacity=".1"/><stop offset="1" stop-color="#100e22" stop-opacity=".66"/></radialGradient>
      <linearGradient id="back-shade" x2=".15" y2="1"><stop stop-color="#120e24" stop-opacity=".5"/><stop offset=".3" stop-color="#a96c98" stop-opacity="0"/><stop offset=".72" stop-color="#30203e" stop-opacity=".04"/><stop offset="1" stop-color="#110d23" stop-opacity=".64"/></linearGradient>
    </defs>
    <path d="M0 0H1440V1000H0Z" fill="#724461"/>${panels}
    <path d="M0 0H1440V1000H0Z" fill="url(#stage-spot)"/>
    <path d="M0 0H1440V1000H0Z" fill="url(#back-shade)"/>
    <path d="M0 0H1440V1000H0Z" fill="url(#velvet-grain)" opacity=".75"/>
  </svg>`;
}

function valance() {
  const swag = 'M0 0H420C349 99 267 207 153 180C94 167 43 132 0 98Z';
  const folds = `<path d="M4 0C94 123 218 198 375 23C276 172 190 203 112 151C55 112 17 64 4 0Z" fill="url(#swag-reflect)"/>
    <path d="M38 0C115 105 206 158 335 61C238 158 177 182 110 126C68 91 48 44 38 0Z" fill="#0e0d21" opacity=".65"/>
    <path d="M51 0C122 95 216 156 335 61C217 164 129 120 76 56Z" fill="url(#swag-reflect)" opacity=".8"/>
    <path d="M104 0C151 71 233 110 299 81C216 125 144 77 129 50Z" fill="#100f23" opacity=".8"/>
    <path d="M118 0C173 80 236 102 302 73C249 107 181 82 148 45Z" fill="#6f4c75" opacity=".22"/>
    <path d="M182 0C215 35 267 49 321 24C266 65 215 42 197 26Z" fill="#0c0d1d" opacity=".65"/>
    <path d="M0 58C90 183 209 240 344 99C249 214 166 211 93 166C49 138 17 99 0 79Z" fill="#0c0c1c" opacity=".7"/>
    <path d="M0 73C87 181 204 226 324 122C233 205 166 211 99 172C60 149 17 107 0 85Z" fill="url(#swag-reflect)"/>
    <path d="M0 96C44 129 94 165 153 178C266 205 348 98 418 0" fill="none" stroke="#b49a69" stroke-width=".9" opacity=".45" vector-effect="non-scaling-stroke"/>`;
  return `<svg class="theatre-valance" viewBox="0 0 1440 240" preserveAspectRatio="none">
    <defs>
      <linearGradient id="valance-base" x2=".1" y2="1"><stop stop-color="#111021"/><stop offset=".46" stop-color="#292038"/><stop offset=".78" stop-color="#34243e"/><stop offset="1" stop-color="#171324"/></linearGradient>
      <linearGradient id="swag-reflect" x2=".15" y2="1"><stop stop-color="#372c4c" stop-opacity=".12"/><stop offset=".46" stop-color="#6c4a73" stop-opacity=".46"/><stop offset=".7" stop-color="#926486" stop-opacity=".44"/><stop offset="1" stop-color="#2d233d" stop-opacity=".18"/></linearGradient>
      <linearGradient id="center-reflect" x2="0" y2="1"><stop stop-color="#19152a"/><stop offset=".7" stop-color="#3e2c4a"/><stop offset=".92" stop-color="#674663"/><stop offset="1" stop-color="#2c2138"/></linearGradient>
      <clipPath id="left-swag"><path d="${swag}"/></clipPath>
    </defs>
    <path d="M0 0H1440V80Q1260 236 1090 112Q915 166 720 89Q525 166 350 112Q180 236 0 80Z" fill="#0c0a18" opacity=".5" transform="translate(0 9)"/>
    <path d="M0 0H1440V65Q1260 222 1090 98Q915 153 720 75Q525 153 350 98Q180 222 0 65Z" fill="url(#valance-base)"/>
    <g id="center-swag">
      <path d="M320 0H720V75C582 141 424 135 320 0Z" fill="url(#center-reflect)"/>
      <path d="M349 0C455 111 586 113 704 5C590 144 444 113 349 0Z" fill="#100e22" opacity=".8"/>
      <path d="M379 0C471 78 602 85 714 0C601 106 472 90 379 0Z" fill="url(#swag-reflect)"/>
      <path d="M423 0C496 50 593 57 661 12C584 80 492 62 423 0Z" fill="#141125" opacity=".55"/>
      <path d="M347 45C457 139 609 126 720 67L720 75C576 139 440 127 347 45Z" fill="#8f6385" opacity=".2"/>
    </g>
    <use href="#center-swag" transform="translate(1440 0) scale(-1 1)"/>
    <g id="corner-swag"><path d="${swag}" fill="url(#valance-base)"/><g clip-path="url(#left-swag)">${folds}<path d="M0 0H420V240H0Z" fill="url(#velvet-grain)" opacity=".7"/></g></g>
    <use href="#corner-swag" transform="translate(1440 0) scale(-1 1)"/>
    <path d="M697 0C692 35 699 66 720 87C718 49 737 24 743 0Z" fill="#151224"/>
    <path d="M705 0C702 36 709 67 720 80C715 43 729 20 732 0Z" fill="#67486d" opacity=".4"/>
  </svg>`;
}

function wing(right: boolean) {
  const id = right ? 'right' : 'left';
  const outline = 'M0 0H220C188 111 181 187 137 302C99 402 55 473 70 589C87 720 52 819 122 936Q154 976 216 1000H0Z';
  return `<svg class="theatre-wing ${right ? 'theatre-wing-right' : ''}" viewBox="0 0 220 1000" preserveAspectRatio="none">
    <defs>
      <linearGradient id="wing-base-${id}"><stop stop-color="#121021"/><stop offset=".55" stop-color="#251d35"/><stop offset="1" stop-color="#3f2b49"/></linearGradient>
      <linearGradient id="wing-light-${id}"><stop stop-color="#19172c" stop-opacity=".15"/><stop offset=".38" stop-color="#57415f" stop-opacity=".68"/><stop offset=".64" stop-color="#7a5378" stop-opacity=".58"/><stop offset=".86" stop-color="#3e2e4a" stop-opacity=".28"/><stop offset="1" stop-color="#19172c" stop-opacity="0"/></linearGradient>
      <linearGradient id="wing-rim-${id}"><stop stop-color="#36253f" stop-opacity="0"/><stop offset=".6" stop-color="#936286" stop-opacity=".32"/><stop offset="1" stop-color="#37243f" stop-opacity="0"/></linearGradient>
      <clipPath id="wing-clip-${id}"><path d="${outline}"/></clipPath>
    </defs>
    <path d="${outline}" fill="url(#wing-base-${id})"/>
    <g clip-path="url(#wing-clip-${id})">
      <path d="M168 0H202C169 206 121 349 83 458C50 574 103 703 72 826C81 904 117 967 173 1000H106C68 932 44 854 57 776C76 657 35 549 63 437C104 277 150 137 168 0Z" fill="url(#wing-light-${id})"/>
      <path d="M153 0H172C142 210 104 340 65 457C45 558 68 675 52 783C43 881 70 956 113 1000H76C39 907 26 854 36 768C57 654 28 539 48 443C86 314 133 117 153 0Z" fill="#0d1023" opacity=".8"/>
      <path d="M101 0H148C124 169 96 301 53 440C26 545 57 631 35 765C24 871 50 946 75 1000H26C5 904 11 859 19 776C34 653 9 556 29 454C56 312 91 160 101 0Z" fill="url(#wing-light-${id})"/>
      <path d="M91 0H106C100 206 52 365 31 487C17 597 36 664 17 800L6 1000H0V776C18 656 1 572 14 473C37 326 79 145 91 0Z" fill="#0d0f22" opacity=".72"/>
      <path d="M33 0H82C78 157 41 324 13 441L0 507V286C27 158 39 76 33 0Z" fill="url(#wing-light-${id})"/>
      <path d="M209 0H229C201 217 137 370 94 466C72 535 102 642 95 735L66 804C86 663 53 573 68 505C104 379 175 214 209 0Z" fill="url(#wing-rim-${id})"/>
      <path d="M70 821C81 889 113 928 151 950L99 945C68 921 51 869 50 845Z" fill="#0d0e20" opacity=".8"/>
      <path d="M54 858C85 937 148 935 187 985C113 949 56 957 54 858Z" fill="url(#wing-light-${id})"/>
      <path d="M36 918C86 964 117 957 162 1000H109C77 973 48 966 36 918Z" fill="#0d0e20" opacity=".7"/>
      <path d="M0 0H220V1000H0Z" fill="url(#velvet-grain)" opacity=".85"/>
      <g fill="none" stroke="#c5ad70" stroke-width="1" opacity=".5"><path d="M7 423Q43 489 83 448M9 435Q40 510 80 463M10 815Q42 893 95 902" vector-effect="non-scaling-stroke"/><path d="M37 210L112 257L52 305L21 291M17 704L44 744L20 778" vector-effect="non-scaling-stroke"/></g>
      <g fill="#c9b579" opacity=".6"><circle cx="37" cy="210" r="2.5"/><circle cx="112" cy="257" r="2.5"/><circle cx="52" cy="305" r="2.5"/><circle cx="21" cy="291" r="2.5"/><path d="M39 552l4 14 11 4-11 4-4 14-4-14-11-4 11-4Z"/><path d="M36 654a16 16 0 1 1 13-27 14 14 0 0 0-13 27"/></g>
    </g>
  </svg>`;
}

function ornaments() {
  // One exact crescent silhouette supplies the fill, edge, highlights and pendants.
  const crescent = 'M45 13A48 48 0 1 1 45 107A50 50 0 0 0 45 13Z';
  return `<svg class="theatre-ornament theatre-star" viewBox="0 0 130 230"><defs><linearGradient id="star-gold" x2=".8" y2="1"><stop stop-color="#e5d08d"/><stop offset=".4" stop-color="#b9a166"/><stop offset=".74" stop-color="#8e7448"/><stop offset="1" stop-color="#c7af72"/></linearGradient></defs>
    <path d="M65 13L74 44 104 33 88 61 115 79 82 79 83 113 64 87 42 113 45 80 12 77 39 59 24 32 55 44Z" fill="url(#star-gold)"/>
    <path d="M65 13 65 69 55 44ZM104 33 65 69 74 44ZM115 79 65 69 88 61ZM83 113 65 69 82 79ZM42 113 65 69 64 87ZM12 77 65 69 45 80ZM24 32 65 69 39 59Z" fill="#f2e2a6" opacity=".22"/>
    <path d="M65 13 65 69 74 44ZM104 33 65 69 88 61ZM115 79 65 69 82 79ZM83 113 65 69 64 87Z" fill="#4d3f2e" opacity=".22"/>
    <path d="M41 119V178M89 120V148" stroke="#c4ad70" stroke-width=".9" opacity=".65"/><path d="M41 178l3 12 9 3-9 3-3 12-3-12-9-3 9-3ZM89 148l2 7 6 2-6 2-2 7-2-7-6-2 6-2Z" fill="#deca8d"/>
  </svg><svg class="theatre-ornament theatre-moon" viewBox="0 0 130 230">
    <defs><path id="crescent-shape" d="${crescent}"/><clipPath id="crescent-clip"><use href="#crescent-shape"/></clipPath>
      <linearGradient id="moon-gold" x1=".1" y1=".1" x2=".9" y2=".8"><stop stop-color="#f0dfa6"/><stop offset=".28" stop-color="#d1b779"/><stop offset=".56" stop-color="#97804e"/><stop offset=".79" stop-color="#ba9d60"/><stop offset="1" stop-color="#e0c78b"/></linearGradient>
    </defs>
    <g id="crescent-metal"><use href="#crescent-shape" fill="url(#moon-gold)"/>
      <g clip-path="url(#crescent-clip)"><use href="#crescent-shape" fill="none" stroke="#f3dfa2" stroke-width="2" opacity=".55"/><use href="#crescent-shape" fill="none" stroke="#54432f" stroke-width="5" opacity=".3" transform="translate(-3 1)"/>
        <path d="M63 10C112 26 117 87 61 109C102 81 106 42 63 10Z" fill="#e6d39a" opacity=".19"/>
      </g>
    </g>
    <path d="M45 127V180M90 124V153" stroke="#c4ad70" stroke-width=".9" opacity=".65"/>
    <use href="#crescent-metal" transform="translate(33.3 176.62) scale(.26)"/>
    <use href="#crescent-metal" transform="translate(81 150.4) scale(.2)"/>
  </svg>`;
}

export function mountTheatre() {
  const stage = document.createElement('div');
  stage.className = 'theatre';
  stage.setAttribute('aria-hidden', 'true');
  stage.innerHTML = backdrop() + wing(false) + wing(true) + valance() + ornaments();
  // X5/QQ night mode can recolour inline SVG solid fills while leaving gradients alone.
  // Isolate each vector image, including its own paint servers, from DOM auto-darkening.
  for (const svg of stage.querySelectorAll('svg')) {
    if (!svg.querySelector('#velvet-grain') && svg.innerHTML.includes('url(#velvet-grain)')) {
      svg.insertAdjacentHTML('afterbegin', `<defs>${fabricGrain()}</defs>`);
    }
    // XMLSerializer adds the default SVG namespace. Use the XMLNS namespace for xlink.
    svg.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:xlink', 'http://www.w3.org/1999/xlink');
    for (const use of svg.querySelectorAll('use[href]')) use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', use.getAttribute('href')!);
    const image = document.createElement('img');
    image.className = svg.getAttribute('class') || ''; image.alt = ''; image.draggable = false;
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    svg.replaceWith(image);
  }
  document.getElementById('app')!.prepend(stage);
}
