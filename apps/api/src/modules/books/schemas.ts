import { z } from 'zod';
import { BOOK_STATUSES, MOOD_TAGS, type BookStatus, type MoodTag } from '@paper-book-traces/shared';

const nullableText = (max: number) =>
  z.preprocess(
    (value) => (value === '' ? null : value),
    z.string().trim().max(max).nullable().optional()
  );

function isValidIsbn(value: string): boolean {
  const isbn = value.replace(/[-\s]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(isbn)) {
    const sum = [...isbn].reduce((acc, char, index) => acc + (char === 'X' ? 10 : Number(char)) * (10 - index), 0);
    return sum % 11 === 0;
  }
  if (/^\d{13}$/.test(isbn)) {
    const sum = [...isbn].reduce(
      (acc, char, index) => acc + Number(char) * (index % 2 === 0 ? 1 : 3),
      0
    );
    return sum % 10 === 0;
  }
  return false;
}

export const isbnSchema = z.preprocess(
  (value) => (value === '' || value === null ? null : String(value).replace(/[-\s]/g, '').toUpperCase()),
  z
    .string()
    .max(20)
    .refine(isValidIsbn, '请输入有效的 ISBN-10 或 ISBN-13')
    .nullable()
    .optional()
);

export const createBookSchema = z.object({
  title: z.string().trim().min(1, '请输入书名').max(300),
  author: nullableText(300),
  publisher: nullableText(300),
  publicationYear: z.number().int().min(1000).max(new Date().getFullYear()).nullable().optional(),
  isbn: isbnSchema,
  pageCount: z.number().int().min(1).max(100_000).nullable().optional(),
  coverUrl: z
    .preprocess(
      (value) => (value === '' ? null : value),
      z
        .string()
        .url('封面地址无效')
        .refine((value) => value.startsWith('http://') || value.startsWith('https://'), '仅支持 http/https 地址')
        .nullable()
        .optional()
    ),
  status: z.enum(['TO_READ', 'READING', 'PAUSED', 'ABANDONED']).default('TO_READ')
});

export const updateBookSchema = createBookSchema.omit({ status: true }).partial().extend({
  version: z.number().int().positive().optional()
}).refine((value) => Object.keys(value).some((key) => key !== 'version'), {
  message: '至少提供一个要更新的字段'
});

export const reflectionInputSchema = z.object({
  moodTags: z.array(z.enum(MOOD_TAGS as [MoodTag, ...MoodTag[]])).min(1).max(3),
  text: z.string().max(5000).optional().default(''),
  completedAt: z.string().datetime({ offset: true }).optional()
});

export const statusSchema = z.object({
  status: z.enum(BOOK_STATUSES as [BookStatus, ...BookStatus[]]),
  version: z.number().int().positive().optional(),
  reflection: reflectionInputSchema.optional()
});

export type CreateBookInput = z.infer<typeof createBookSchema>;
export type UpdateBookInput = z.infer<typeof updateBookSchema>;
export type StatusInput = z.infer<typeof statusSchema>;
