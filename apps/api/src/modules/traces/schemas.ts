import { z } from 'zod';
import { TRACE_TYPES, type TraceType } from '@paper-book-traces/shared';
import { AppError, zodFields } from '../../lib/errors.js';
import { optionalDate } from '../../lib/http.js';

const optionalReason = (max: number) =>
  z.preprocess(
    (value) => (value === '' ? null : value),
    z.string().trim().max(max).nullable().optional()
  );

export const dogEarCreateSchema = z.object({
  pageNumber: z.number().int().positive(),
  reason: optionalReason(500)
});

export const dogEarUpdateSchema = z
  .object({
    pageNumber: z.number().int().positive().optional(),
    reason: optionalReason(500),
    version: z.number().int().positive().optional()
  })
  .refine((value) => value.pageNumber !== undefined || value.reason !== undefined, {
    message: '至少提供一个要更新的字段'
  });

export const annotationCreateSchema = z.object({
  startPage: z.number().int().positive(),
  endPage: z.number().int().positive(),
  content: z.string().trim().min(1, '请输入批注').max(5000)
});

export const annotationUpdateSchema = z
  .object({
    startPage: z.number().int().positive().optional(),
    endPage: z.number().int().positive().optional(),
    content: z.string().trim().min(1).max(5000).optional(),
    version: z.number().int().positive().optional()
  })
  .refine((value) => value.startPage !== undefined || value.endPage !== undefined || value.content !== undefined, {
    message: '至少提供一个要更新的字段'
  });

export const rereadCreateSchema = z.object({
  pageNumber: z.number().int().positive(),
  reason: optionalReason(1000)
});

export const rereadUpdateSchema = z
  .object({
    pageNumber: z.number().int().positive().optional(),
    reason: optionalReason(1000),
    version: z.number().int().positive().optional()
  })
  .refine((value) => value.pageNumber !== undefined || value.reason !== undefined, {
    message: '至少提供一个要更新的字段'
  });

export const deleteSchema = z.object({ version: z.number().int().positive().optional() }).optional();

export type DogEarCreateInput = z.infer<typeof dogEarCreateSchema>;
export type DogEarUpdateInput = z.infer<typeof dogEarUpdateSchema>;
export type AnnotationCreateInput = z.infer<typeof annotationCreateSchema>;
export type AnnotationUpdateInput = z.infer<typeof annotationUpdateSchema>;
export type RereadCreateInput = z.infer<typeof rereadCreateSchema>;
export type RereadUpdateInput = z.infer<typeof rereadUpdateSchema>;
export type DeleteInput = z.infer<typeof deleteSchema>;

/** 与旧路由一致：校验失败统一返回 422 VALIDATION_ERROR 及字段错误。 */
export function parseBody<Output>(
  schema: z.ZodType<Output, z.ZodTypeDef, unknown>,
  body: unknown,
  message: string
): Output {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(422, 'VALIDATION_ERROR', message, zodFields(parsed.error));
  }
  return parsed.data;
}

export interface TraceListFilter {
  type?: TraceType;
  pageNumber?: number;
  keyword: string;
  from?: Date;
  to?: Date;
}

export function parseTraceListQuery(query: Record<string, unknown>): TraceListFilter {
  const type = typeof query.type === 'string' && query.type !== 'ALL' ? query.type : undefined;
  if (type && !TRACE_TYPES.includes(type as TraceType)) {
    throw new AppError(422, 'VALIDATION_ERROR', '痕迹类型无效');
  }
  const pageNumber = query.pageNumber === undefined ? undefined : Number(query.pageNumber);
  if (pageNumber !== undefined && (!Number.isInteger(pageNumber) || pageNumber < 1)) {
    throw new AppError(422, 'VALIDATION_ERROR', '页码无效');
  }
  const keyword = typeof query.keyword === 'string' ? query.keyword.trim() : '';
  const from = optionalDate(query.from, 'from');
  const to = optionalDate(query.to, 'to');
  return { type: type as TraceType | undefined, pageNumber, keyword, from, to };
}
