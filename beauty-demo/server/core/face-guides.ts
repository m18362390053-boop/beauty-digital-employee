export const FACE_GUIDE_SKILL_ID = 'face-area-visual-guide';

export const faceRegions = ['full_face', 'under_eye', 'forehead', 'cheek', 'nose', 'chin', 't_zone', 'nasolabial_fold', 'flaky_area'] as const;
export type FaceRegion = typeof faceRegions[number];

export interface FaceGuide {
  region: FaceRegion;
  title: string;
  location: string;
  application: string;
  caution: string;
}

const guides: Record<FaceRegion, Omit<FaceGuide, 'region'>> = {
  full_face: {
    title: '面霜常见涂抹区域示意',
    location: '高亮表示额头、两颊、鼻部外侧和下巴等常见面部区域；眼皮、眼周、嘴唇和鼻孔不在示意范围内。',
    application: '只有产品标签允许用于全脸时，才按说明取量，分点后轻轻铺开；不同面霜的适用范围可能不同。',
    caution: '这张通用图不代表某个具体产品的使用许可；眼周或局部专用产品请按包装说明使用。',
  },
  under_eye: {
    title: '卧蚕与眼周位置示意',
    location: '卧蚕是紧贴下睫毛下方的微隆起区域。图中亮色标出位置，不代表这里都适合涂护肤品。',
    application: '如产品标签允许用于眼周，只在眼眶骨附近轻点涂开；不要沿下睫毛根来回推拉。',
    caution: '避开眼球、睫毛根和内眼角；刺痛、红肿或视物异常时停用并寻求专业建议。',
  },
  forehead: {
    title: '额头位置示意',
    location: '亮色区域是眉毛上方到发际线下方的额头。',
    application: '按产品标签取适量，轻轻铺开即可；不必用力提拉。',
    caution: '避开眼睛和破损皮肤；如有不适，停止使用。',
  },
  cheek: {
    title: '脸颊位置示意',
    location: '亮色区域是鼻翼两侧、颧骨下方到面部外侧的脸颊。',
    application: '按产品标签轻轻涂匀，不以摩擦到发热为目标。',
    caution: '避开眼睛和破损皮肤；如有不适，停止使用。',
  },
  nose: {
    title: '鼻部位置示意',
    location: '亮色区域是鼻梁和鼻翼外侧，不包括鼻孔内部。',
    application: '按产品标签薄薄涂开，不用力挤压鼻翼。',
    caution: '不要涂入鼻孔或眼睛；如有不适，停止使用。',
  },
  chin: {
    title: '下巴位置示意',
    location: '亮色区域位于下唇下方至下颌边缘。',
    application: '按产品标签轻轻涂匀即可。',
    caution: '避开口唇黏膜和破损皮肤；如有不适，停止使用。',
  },
  t_zone: {
    title: '常说的出油 T 区',
    location: '图中蓝色部分连着额头、鼻梁和鼻翼，形状像字母 T；这是解释“常见出油位置”的示意，不代表您一定是油性皮肤。',
    application: '清洁或护肤时按产品标签轻柔涂抹，不必反复搓洗到发涩。',
    caution: '如果只有脸颊出油，或同时明显干燥，应以自己的实际感受为准，不靠这张图判断肤质。',
  },
  nasolabial_fold: {
    title: '法令纹在哪里',
    location: '图中两条高亮弧线从鼻翼旁向嘴角延伸，表示日常所说的法令纹位置。',
    application: '护肤品在这一区域按标签轻轻铺开即可，不用用力向上推拉。',
    caution: '示意图不判断皱纹程度；普通涂抹不能保证消除法令纹。',
  },
  flaky_area: {
    title: '容易起皮的位置示例',
    location: '图中点状高亮在鼻翼旁和下巴，便于理解“局部起皮”所指的位置；实际起皮区域因人而异。',
    application: '如果只是干燥，可按已审核产品说明轻柔保湿，不要反复摩擦或硬搓皮屑。',
    caution: '如伴随疼痛、明显红肿、渗液或持续加重，不继续按普通护肤问题处理。',
  },
};

export const hasFaceGuideSafetyConcern = (text: string) => /刺痛|疼痛|红肿|肿胀|破皮|感染|视力|看不清|进眼睛|消肿|治疗|医美|手术|整形|诊断|过敏|出血|流脓|发炎|皮疹|湿疹/.test(text);

export function faceGuideFor(text: string, options: { locationOnly?: boolean } = {}): FaceGuide | null {
  if (hasFaceGuideSafetyConcern(text) && !options.locationOnly) return null;
  const asksApplication = /涂|抹|擦|怎么用|使用方法|用法/.test(text);
  const asksWholeFace = /全脸|整张脸|脸上|脸部|面部/.test(text);
  const asksFaceCreamArea = /面霜|乳液|润肤霜/.test(text) && /哪里|哪个区域|哪些区域|什么区域|哪些部位|什么部位/.test(text);
  const asksWhetherOnlyEye = /只|仅/.test(text) && /眼下|眼周/.test(text);
  const region: FaceRegion | null = /法令纹|鼻唇沟/.test(text) ? 'nasolabial_fold'
    : /起皮|死皮|脱皮/.test(text) ? 'flaky_area'
    : /T区|t区|油皮区域|额头.{0,8}鼻.{0,8}出油/.test(text) ? 't_zone'
    : /卧蚕|眼周|眼下|下眼睑|眼袋|眼霜/.test(text) && !(/面霜|乳液|润肤霜/.test(text) && asksWhetherOnlyEye) ? 'under_eye'
    : /额头|抬头纹/.test(text) ? 'forehead'
    : /脸颊|面颊|苹果肌|颧骨/.test(text) ? 'cheek'
    : /鼻翼|鼻梁|鼻子/.test(text) ? 'nose'
    : /下巴|下颌/.test(text) ? 'chin'
    : asksApplication && (asksWholeFace || asksFaceCreamArea || asksWhetherOnlyEye && /面霜|乳液|润肤霜/.test(text)) ? 'full_face' : null;
  if (!region) return null;
  const guide = { region, ...guides[region] };
  return options.locationOnly ? {
    ...guide,
    application: '这张图只帮助辨认面部位置，不是当前的涂抹建议；出现不适时不要按图继续使用产品。',
    caution: '如有过敏、刺痛、红肿、破损或症状加重，请先停用相关产品，并向专业人员咨询。示意图不能判断皮肤问题。',
  } : guide;
}
