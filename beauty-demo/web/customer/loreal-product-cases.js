// Curated from the team's dated SKU cards; candidates remain unverified until the person checks the bottle.
export const LOREAL_PRODUCT_CASES = [
  {
    id: 'SKU-01',
    name: '欧莱雅复颜专研抗皱紧致乳',
    aliases: ['REVITALIFT MILKY TONER', '复颜专研抗皱紧致乳', '复颜紧致乳'],
    category: '乳液',
    area: '面部、颈部',
    period: 'both',
    paoMonths: null,
    paoLabel: '资料卡待实物核对；官网链接当前标题与规格不一致',
    volume: '110ml（资料卡记录）',
    source: '团队 SKU-01 资料卡（草稿，2026-10-13）',
    sourceUrl: 'https://www.lorealparis.com.cn/product/PZnxLY49TzDoZoXLvMNqZU/',
    sourceConflict: '该卡链接当前显示“复颜清乳柔肤水 / 130ml”，与卡片“复颜专研抗皱紧致乳 / 110ml”不一致。仅在正反面都匹配时推荐此卡，并要求人工核对。',
  },
  {
    id: 'SKU-02',
    name: '欧莱雅清润葡萄籽强韧修护膜力水',
    aliases: ['HYDRA FRESH GRAPE SEED HYDRATING MASK-IN BARRIER LOTION', '清润葡萄籽强韧修护膜力水', '葡萄籽膜力水'],
    category: '化妆水',
    area: '面部、颈部',
    period: 'both',
    paoMonths: null,
    paoLabel: '开封后期限以瓶身开盖标志为准；资料卡未标注 PAO',
    volume: '130ml（资料卡实物记录）',
    source: '团队 SKU-02 资料卡（2026-10-14）及巴黎欧莱雅中国官网',
    sourceUrl: 'https://www.lorealparis.com.cn/hydra-fresh/hydra-fresh-anti-ox-grape-seed-hydrating-mask-in-barrier-lotion-130ml',
    usage: '每天早晚使用；清洁后用于脸部及颈部。可用化妆棉轻擦或手心轻拍。',
    sourceConflict: '资料卡列出的“三年”是未开封保质期，不等于开封后 PAO；系统不据此推算开封后到期日。',
  },
];

export function matchLorealCase(text) {
  const normalized = String(text ?? '').toLocaleLowerCase().replace(/[\s·・，,。:：/\\_-]/g, '');
  if (!normalized) return null;
  const matches = LOREAL_PRODUCT_CASES.map(item => ({ item, score: item.aliases.reduce((score, alias) => {
    const key = alias.toLocaleLowerCase().replace(/[\s·・，,。:：/\\_-]/g, '');
    return normalized.includes(key) ? Math.max(score, key.length) : score;
  }, 0) })).filter(result => result.score >= 6).sort((a, b) => b.score - a.score);
  return matches.length && (matches.length === 1 || matches[0].score > matches[1].score) ? matches[0].item : null;
}
