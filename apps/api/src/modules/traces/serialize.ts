export function serializeDogEar(item: {
  id: string;
  bookId: string;
  version: number;
  pageNumber: number;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return { ...item, type: 'DOG_EAR' as const };
}

export function serializeAnnotation(item: {
  id: string;
  bookId: string;
  version: number;
  startPage: number;
  endPage: number;
  content: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return { ...item, type: 'ANNOTATION' as const };
}

export function serializeRereadMark(item: {
  id: string;
  bookId: string;
  version: number;
  pageNumber: number;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return { ...item, type: 'REREAD_MARK' as const };
}
