import type { Annotation, DogEar, RereadMark } from '@prisma/client';

export function serializeDogEar(item: DogEar) {
  return { ...item, type: 'DOG_EAR' as const };
}

export function serializeAnnotation(item: Annotation) {
  return { ...item, type: 'ANNOTATION' as const };
}

export function serializeRereadMark(item: RereadMark) {
  return { ...item, type: 'REREAD_MARK' as const };
}
