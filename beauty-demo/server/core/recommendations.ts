import type { ProductDocument } from '../contracts/index.js';
import type { ConsultResult } from './workflow-types.js';

export function recommendProducts(products: ProductDocument[], category: string, conversation: string): ConsultResult['productCards'] {
  const relevant = conversation.includes(category) || (category === '口红' && /唇色|唇形|唇线|豆沙|唇膏/.test(conversation));
  if (!relevant) return [];
  return products.filter(product => product.recommendation?.category === category && product.facts.length > 0)
    .map(product => ({ product, score: product.recommendation!.keywords.filter(word => conversation.includes(word)).length }))
    .sort((a, b) => b.score - a.score || a.product.productId.localeCompare(b.product.productId))
    .slice(0, 3).map(({ product }) => ({
      productId: product.productId, name: product.name, shade: product.recommendation!.shade,
      texture: product.recommendation!.texture,
      ...(product.recommendation!.imageUrl ? { imageUrl: product.recommendation!.imageUrl } : {}),
      ...(product.recommendation!.price !== undefined ? { price: product.recommendation!.price } : {}),
      sourceId: product.recommendation!.sourceId, dataKind: product.dataKind,
    }));
}
