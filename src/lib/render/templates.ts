import { fontFaceCss, FONT_FAMILIES } from "./fonts";
import type { RenderRequest, SlideType } from "./types";
import type { BrandTokens, TenantConfig } from "@/lib/tenants";

/**
 * Slide markup.
 *
 * Every typographic element on a slide is rendered here, deterministically,
 * from tenant brand tokens. Nothing on a slide comes out of an image model:
 * disclaimer text in particular has to be exact, diffable and versionable.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function color(tokens: BrandTokens, name: string, fallback: string): string {
  return tokens?.color?.[name] ?? fallback;
}

interface Palette {
  navy: string;
  cream: string;
  sage: string;
  sageTint: string;
  gold: string;
  goldText: string;
  goldLight: string;
  slate: string;
  rule: string;
  cardBorder: string;
  navySub: string;
  navyFooter: string;
  navyRule: string;
}

function palette(tokens: BrandTokens): Palette {
  return {
    navy: color(tokens, "navy", "#17395C"),
    cream: color(tokens, "cream", "#F7F4ED"),
    sage: color(tokens, "sage", "#56653C"),
    sageTint: color(tokens, "sage_tint", "#E4E7DA"),
    gold: color(tokens, "gold", "#A08A4B"),
    goldText: color(tokens, "gold_text", "#7A6534"),
    goldLight: color(tokens, "gold_light", "#C9A961"),
    slate: color(tokens, "slate", "#5A6B7D"),
    rule: color(tokens, "rule", "#DED8C8"),
    cardBorder: color(tokens, "card_border", "#E3DDCC"),
    navySub: color(tokens, "navy_sub", "#C8D2DC"),
    navyFooter: color(tokens, "navy_footer", "#A8BACA"),
    navyRule: color(tokens, "navy_rule", "#2E5175"),
  };
}

function kickerBlock(text: string, p: Palette, onNavy = false): string {
  const fg = onNavy ? p.goldLight : p.sage;
  const rule = onNavy ? p.goldLight : p.gold;
  return `<div class="kicker">
  <div style="font-size:17px;font-weight:500;letter-spacing:3.8px;text-transform:uppercase;color:${fg};">${escapeHtml(text)}</div>
  <div style="width:70px;height:2px;background:${rule};margin-top:18px;"></div>
</div>`;
}

function footerBlock(tenant: TenantConfig, p: Palette, onNavy = false): string {
  const left = tenant.footer?.left ?? tenant.website ?? "";
  const right = onNavy
    ? (tenant.footer?.contact ?? "")
    : (tenant.footer?.right ?? "");
  const fg = onNavy ? p.navyFooter : p.sage;
  const line = onNavy ? p.navyRule : p.rule;
  return `<div class="footer">
  <div style="height:1px;background:${line};"></div>
  <div style="margin-top:22px;display:flex;justify-content:space-between;align-items:center;gap:24px;">
    <span style="font-size:15px;font-weight:500;letter-spacing:1.9px;text-transform:uppercase;color:${fg};">${escapeHtml(left)}</span>
    <span style="font-size:15px;font-weight:400;letter-spacing:1.9px;text-transform:uppercase;color:${fg};text-align:right;">${escapeHtml(right)}</span>
  </div>
</div>`;
}

function hookSlide(copy: Record<string, unknown>, photoUrl: string | null | undefined, tenant: TenantConfig, p: Palette): string {
  const slot = tenant.templates?.symptom_carousel?.slide_specs?.hook?.photo_slot ?? {
    x: 0, y: 0, w: 1080, h: 560,
  };
  const photo = photoUrl
    ? `<img src="${escapeHtml(photoUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">`
    : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:${p.sageTint};">
         <div style="font-family:${FONT_FAMILIES.body};font-size:19px;letter-spacing:2px;text-transform:uppercase;color:${p.sage};">Photo pending</div>
       </div>`;
  return `<div class="slide" style="background:${p.cream};display:flex;flex-direction:column;">
  <div style="width:${slot.w}px;height:${slot.h}px;overflow:hidden;background:${p.sageTint};flex:0 0 auto;">${photo}</div>
  <div style="flex:1 1 auto;min-height:0;box-sizing:border-box;padding:60px 76px 58px;display:flex;flex-direction:column;justify-content:space-between;gap:24px;">
    <div class="grow" style="display:flex;flex-direction:column;justify-content:center;gap:30px;min-height:0;">
      ${kickerBlock(String(copy.kicker ?? ""), p)}
      <h1 data-fit="86,46" style="margin:0;font-family:${FONT_FAMILIES.display};font-weight:600;font-size:86px;line-height:1.03;letter-spacing:-0.5px;color:${p.navy};">${escapeHtml(copy.headline)}</h1>
      <p data-fit="48,28" style="margin:0;font-family:${FONT_FAMILIES.script};font-size:48px;line-height:1.3;color:${p.goldText};">${escapeHtml(copy.script_line)}</p>
    </div>
    <div style="display:flex;align-items:center;gap:14px;">
      <span style="font-size:16px;font-weight:500;letter-spacing:3px;text-transform:uppercase;color:${p.sage};">Swipe</span>
      <svg width="40" height="10" viewBox="0 0 40 10" fill="none"><path d="M0 5h36M32 1l5 4-5 4" stroke="${p.sage}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
  </div>
</div>`;
}

function causeSlide(copy: Record<string, unknown>, tenant: TenantConfig, p: Palette): string {
  const items = Array.isArray(copy.items)
    ? (copy.items as { label: string; text: string }[])
    : [];
  const cells = items
    .map(
      (item) => `<div style="display:flex;gap:16px;break-inside:avoid;">
      <div style="width:9px;height:9px;border-radius:50%;background:${p.gold};margin-top:13px;flex:0 0 auto;"></div>
      <div>
        <div style="font-size:27px;font-weight:500;line-height:1.22;color:${p.navy};">${escapeHtml(item.label)}</div>
        <div style="margin-top:10px;font-size:20.5px;font-weight:400;line-height:1.5;color:${p.slate};">${escapeHtml(item.text)}</div>
      </div>
    </div>`,
    )
    .join("\n");
  return `<div class="slide" style="background:${p.cream};box-sizing:border-box;padding:78px 76px 62px;display:flex;flex-direction:column;justify-content:space-between;gap:36px;">
  ${kickerBlock(String(copy.kicker ?? ""), p)}
  <div class="grow" style="display:flex;flex-direction:column;justify-content:center;gap:44px;min-height:0;">
    <div>
      <h1 data-fit="70,40" style="margin:0;font-family:${FONT_FAMILIES.display};font-weight:600;font-size:70px;line-height:1.07;letter-spacing:-0.4px;color:${p.navy};">${escapeHtml(copy.headline)}</h1>
      <p data-fit="24,17" style="margin:18px 0 0;font-size:24px;font-weight:400;line-height:1.5;color:${p.slate};max-width:880px;">${escapeHtml(copy.sub)}</p>
    </div>
    <div data-fit-scale="items" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:50px;row-gap:46px;">
${cells}
    </div>
  </div>
  ${footerBlock(tenant, p)}
</div>`;
}

function protocolSlide(copy: Record<string, unknown>, tenant: TenantConfig, p: Palette): string {
  const cards = Array.isArray(copy.cards)
    ? (copy.cards as { title: string; text: string }[])
    : [];
  const grid = cards
    .map(
      (card) => `<div style="background:#FFFFFF;border:1px solid ${p.cardBorder};border-radius:4px;padding:38px 34px;display:flex;flex-direction:column;gap:13px;">
      <div style="font-family:${FONT_FAMILIES.display};font-weight:600;font-size:35px;line-height:1.1;color:${p.navy};">${escapeHtml(card.title)}</div>
      <div style="font-size:19.5px;font-weight:400;line-height:1.5;color:${p.slate};">${escapeHtml(card.text)}</div>
    </div>`,
    )
    .join("\n");
  const disclaimer = String(copy.disclaimer ?? "");
  return `<div class="slide" style="background:${p.cream};box-sizing:border-box;padding:78px 76px 62px;display:flex;flex-direction:column;justify-content:space-between;gap:32px;">
  ${kickerBlock(String(copy.kicker ?? ""), p)}
  <div class="grow" style="display:flex;flex-direction:column;justify-content:center;gap:34px;min-height:0;">
    <h1 data-fit="70,40" style="margin:0;font-family:${FONT_FAMILIES.display};font-weight:600;font-size:70px;line-height:1.07;letter-spacing:-0.4px;color:${p.navy};">${escapeHtml(copy.headline)}</h1>
    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:30px;">
${grid}
    </div>
    ${disclaimer ? `<p data-fit="16,11" style="margin:0;font-size:16px;font-weight:400;line-height:1.5;color:${p.slate};">${escapeHtml(disclaimer)}</p>` : ""}
  </div>
  ${footerBlock(tenant, p)}
</div>`;
}

function ctaSlide(copy: Record<string, unknown>, tenant: TenantConfig, p: Palette): string {
  const points = Array.isArray(copy.trust_points)
    ? (copy.trust_points as string[])
    : [];
  const list = points
    .map(
      (point) => `<div style="display:flex;align-items:flex-start;gap:15px;">
      <svg width="22" height="22" viewBox="0 0 18 18" fill="none" style="margin-top:4px;flex:0 0 auto;"><path d="M3 9.5l4 4L15 5" stroke="${p.goldLight}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span style="font-size:22px;font-weight:400;line-height:1.45;color:${p.navySub};">${escapeHtml(point)}</span>
    </div>`,
    )
    .join("\n");
  return `<div class="slide" style="background:${p.navy};box-sizing:border-box;padding:86px 80px 70px;display:flex;flex-direction:column;justify-content:space-between;gap:34px;">
  ${kickerBlock(String(copy.kicker ?? ""), p, true)}
  <div class="grow" style="display:flex;flex-direction:column;justify-content:center;gap:28px;min-height:0;">
    <h1 data-fit="86,46" style="margin:0;font-family:${FONT_FAMILIES.display};font-weight:600;font-size:86px;line-height:1.04;letter-spacing:-0.6px;color:${p.cream};">${escapeHtml(copy.headline)}</h1>
    <p data-fit="25,17" style="margin:0;font-size:25px;font-weight:400;line-height:1.5;color:${p.navySub};max-width:880px;">${escapeHtml(copy.body)}</p>
    <div style="display:flex;flex-direction:column;gap:19px;margin-top:6px;">
${list}
    </div>
    <div style="align-self:flex-start;margin-top:16px;background:${p.goldLight};color:${p.navy};padding:25px 54px;border-radius:2px;font-size:19px;font-weight:500;letter-spacing:2.6px;text-transform:uppercase;">Book a Consult</div>
  </div>
  ${footerBlock(tenant, p, true)}
</div>`;
}

const RENDERERS: Record<
  SlideType,
  (copy: Record<string, unknown>, photoUrl: string | null | undefined, tenant: TenantConfig, p: Palette) => string
> = {
  hook: (copy, photoUrl, tenant, p) => hookSlide(copy, photoUrl, tenant, p),
  cause: (copy, _photo, tenant, p) => causeSlide(copy, tenant, p),
  protocol: (copy, _photo, tenant, p) => protocolSlide(copy, tenant, p),
  cta: (copy, _photo, tenant, p) => ctaSlide(copy, tenant, p),
};

/**
 * Shrink-to-fit. Generated copy varies in length; a headline that overflows
 * its box is the difference between a slide that ships and one that has to be
 * regenerated. Elements carry data-fit="max,min" in px.
 */
const FIT_SCRIPT = `
(function () {
  function fits(el) {
    return el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1;
  }
  function container(el) {
    var host = el.closest('.grow') || el.parentElement;
    return host;
  }
  document.querySelectorAll('[data-fit]').forEach(function (el) {
    var spec = el.getAttribute('data-fit').split(',');
    var max = parseFloat(spec[0]);
    var min = parseFloat(spec[1]);
    var host = container(el);
    for (var size = max; size >= min; size -= 1) {
      el.style.fontSize = size + 'px';
      if (host.scrollHeight <= host.clientHeight + 1 && fits(el)) return;
    }
    el.style.fontSize = min + 'px';
  });
  // Last resort: if the growing column still overflows, tighten leading.
  document.querySelectorAll('.grow').forEach(function (host) {
    var tries = 0;
    while (host.scrollHeight > host.clientHeight + 1 && tries < 8) {
      host.style.gap = Math.max(8, (parseFloat(getComputedStyle(host).gap) || 24) - 4) + 'px';
      tries++;
    }
  });
  document.documentElement.setAttribute('data-fitted', 'true');
})();
`;

export async function slideHtml(request: RenderRequest): Promise<string> {
  const { tenant, slide } = request;
  const p = palette(tenant.brand_tokens);
  const width = tenant.output?.width ?? 1080;
  const height = tenant.output?.height ?? 1350;
  const render = RENDERERS[slide.type] ?? RENDERERS.hook;
  const body = render(slide.copy, slide.photoUrl, tenant, p);
  const fonts = await fontFaceCss();

  return `<!doctype html>
<html lang="${escapeHtml(tenant.locale ?? "en-US")}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(tenant.name)} — slide ${slide.position}</title>
<style>
${fonts}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;background:${p.cream};}
body{font-family:${FONT_FAMILIES.body};-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;}
.slide{width:${width}px;height:${height}px;overflow:hidden;position:relative;}
.kicker,.footer{flex:0 0 auto;}
h1,p{overflow-wrap:break-word;hyphens:none;}
</style>
</head>
<body>
${body}
<script>${FIT_SCRIPT}</script>
</body>
</html>`;
}
