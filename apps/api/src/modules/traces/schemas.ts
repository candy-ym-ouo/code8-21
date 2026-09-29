import { z } from 'zod';

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
