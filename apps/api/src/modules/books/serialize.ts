import type { BookStatus, MoodTag } from '@paper-book-traces/shared';

export function serializeReflection(reflection: {
  id: string;
  bookId: string;
  completionRound: number;
  moodTags: MoodTag[];
  reflection: string | null;
  completedAt: Date;
  editableUntil: Date;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: reflection.id,
    bookId: reflection.bookId,
    completionRound: reflection.completionRound,
    moodTags: reflection.moodTags,
    text: reflection.reflection ?? '',
    completedAt: reflection.completedAt,
    editableUntil: reflection.editableUntil,
    version: reflection.version,
    createdAt: reflection.createdAt,
    updatedAt: reflection.updatedAt
  };
}

export function serializeBook(book: {
  id: string;
  title: string;
  author: string | null;
  publisher: string | null;
  publicationYear: number | null;
  isbn: string | null;
  pageCount: number | null;
  coverUrl: string | null;
  status: BookStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}) {
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
