import type { MoodTag } from '@paper-book-traces/shared';
import type { Book, CompletionReflection } from '@prisma/client';

/** 旧客户端契约：完成感受的文本字段名为 text，而存储列为 reflection。 */
export function serializeReflection(reflection: CompletionReflection) {
  return {
    id: reflection.id,
    bookId: reflection.bookId,
    completionRound: reflection.completionRound,
    moodTags: reflection.moodTags as MoodTag[],
    text: reflection.reflection ?? '',
    completedAt: reflection.completedAt,
    editableUntil: reflection.editableUntil,
    version: reflection.version,
    createdAt: reflection.createdAt,
    updatedAt: reflection.updatedAt
  };
}

/** 软删除字段不对外暴露。 */
export function serializeBook(book: Book) {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    publisher: book.publisher,
    publicationYear: book.publicationYear,
    isbn: book.isbn,
    pageCount: book.pageCount,
    coverUrl: book.coverUrl,
    status: book.status,
    version: book.version,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt
  };
}
