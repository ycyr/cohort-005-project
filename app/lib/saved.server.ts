import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { bookmarks, courses, lessons, modules, notes } from "~/db/schema";

// ─── Bookmarks and Notes ───
// One Bookmark and one Note per Student per Lesson. Both are private to the
// Student who owns them. Every function takes the database first, so tests can
// hand in an in-memory one (project convention).

export type Db = BetterSQLite3Database<typeof schema>;

export const MAX_NOTE_LENGTH = 2000;

type Note = typeof notes.$inferSelect;

export type NoteFailure = { ok: false; error: string };
export type SaveNoteResult = { ok: true; note: Note | null } | NoteFailure;

function lessonExists(db: Db, lessonId: number) {
  return !!db
    .select({ id: lessons.id })
    .from(lessons)
    .where(eq(lessons.id, lessonId))
    .get();
}

export function getBookmark(db: Db, userId: number, lessonId: number) {
  return db
    .select()
    .from(bookmarks)
    .where(
      and(eq(bookmarks.userId, userId), eq(bookmarks.lessonId, lessonId))
    )
    .get();
}

/** Adds the Bookmark if absent, removes it if present. Returns the new state. */
export function toggleBookmark(
  db: Db,
  userId: number,
  lessonId: number
): boolean {
  const existing = getBookmark(db, userId, lessonId);

  if (existing) {
    db.delete(bookmarks).where(eq(bookmarks.id, existing.id)).run();
    return false;
  }

  db.insert(bookmarks)
    .values({ userId, lessonId })
    .onConflictDoNothing()
    .run();
  return true;
}

export function getNote(db: Db, userId: number, lessonId: number) {
  return db
    .select()
    .from(notes)
    .where(and(eq(notes.userId, userId), eq(notes.lessonId, lessonId)))
    .get();
}

/**
 * Creates or replaces the Student's Note on a Lesson. The body is trimmed and
 * capped; an empty body deletes the Note. Re-saving keeps `createdAt` and
 * moves `updatedAt` on.
 */
export function saveNote(
  db: Db,
  userId: number,
  lessonId: number,
  body: string,
  now: Date
): SaveNoteResult {
  const trimmed = body.trim();
  if (trimmed.length > MAX_NOTE_LENGTH) {
    return {
      ok: false,
      error: `A note must be ${MAX_NOTE_LENGTH} characters or fewer`,
    };
  }

  if (!lessonExists(db, lessonId)) {
    return { ok: false, error: "Lesson not found" };
  }

  if (trimmed.length === 0) {
    db.delete(notes)
      .where(and(eq(notes.userId, userId), eq(notes.lessonId, lessonId)))
      .run();
    return { ok: true, note: null };
  }

  const iso = now.toISOString();
  const note = db
    .insert(notes)
    .values({ userId, lessonId, body: trimmed, createdAt: iso, updatedAt: iso })
    .onConflictDoUpdate({
      target: [notes.userId, notes.lessonId],
      set: { body: trimmed, updatedAt: iso },
    })
    .returning()
    .get();

  return { ok: true, note };
}

/** The current Student's Bookmarks and Notes, newest first, each with its
 * Lesson and Course so the Saved page can link to it. */
export function getSavedForUser(db: Db, userId: number) {
  const savedBookmarks = db
    .select({
      id: bookmarks.id,
      createdAt: bookmarks.createdAt,
      lessonId: lessons.id,
      lessonTitle: lessons.title,
      moduleTitle: modules.title,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(bookmarks)
    .innerJoin(lessons, eq(bookmarks.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(bookmarks.userId, userId))
    .orderBy(desc(bookmarks.createdAt))
    .all();

  const savedNotes = db
    .select({
      id: notes.id,
      body: notes.body,
      updatedAt: notes.updatedAt,
      lessonId: lessons.id,
      lessonTitle: lessons.title,
      moduleTitle: modules.title,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(notes)
    .innerJoin(lessons, eq(notes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(notes.userId, userId))
    .orderBy(desc(notes.updatedAt))
    .all();

  return { savedBookmarks, savedNotes };
}
