import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import {
  getBookmark,
  getNote,
  getSavedForUser,
  MAX_NOTE_LENGTH,
  saveNote,
  toggleBookmark,
} from "./saved.server";
import { approveRefundRequest, raiseRefundRequest } from "./refunds.server";
import {
  fakeNotifications,
  type FakeNotifications,
} from "./notifications.fake.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

function daysBefore(days: number) {
  const when = new Date(NOW);
  when.setDate(when.getDate() - days);
  return when.toISOString();
}

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonId: number;
let secondLessonId: number;
let notifications: FakeNotifications;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  notifications = fakeNotifications();

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  lessonId = db
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "Lesson 1", position: 1 })
    .returning()
    .get().id;
  secondLessonId = db
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "Lesson 2", position: 2 })
    .returning()
    .get().id;
});

function addStudent(name: string) {
  return db
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase()}@example.com`,
      role: UserRole.Student,
    })
    .returning()
    .get();
}

function bookmarkCount(userId: number, targetLessonId: number) {
  return db
    .select()
    .from(schema.bookmarks)
    .where(
      and(
        eq(schema.bookmarks.userId, userId),
        eq(schema.bookmarks.lessonId, targetLessonId)
      )
    )
    .all().length;
}

describe("bookmarks", () => {
  it("adds a bookmark, then removes it on the next toggle", () => {
    expect(toggleBookmark(db, base.user.id, lessonId)).toBe(true);
    expect(getBookmark(db, base.user.id, lessonId)).toBeDefined();

    expect(toggleBookmark(db, base.user.id, lessonId)).toBe(false);
    expect(getBookmark(db, base.user.id, lessonId)).toBeUndefined();
  });

  it("never leaves two bookmarks on the same lesson", () => {
    toggleBookmark(db, base.user.id, lessonId);
    toggleBookmark(db, base.user.id, lessonId);
    toggleBookmark(db, base.user.id, lessonId);

    expect(bookmarkCount(base.user.id, lessonId)).toBe(1);
  });
});

describe("saving a note", () => {
  it("creates a note with the body trimmed", () => {
    expect(saveNote(db, base.user.id, lessonId, "  First thought  ", NOW)).toMatchObject(
      {
        ok: true,
        note: {
          userId: base.user.id,
          lessonId,
          body: "First thought",
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
      }
    );
  });

  it("replaces the body on re-save and moves last edited on, keeping createdAt", () => {
    saveNote(db, base.user.id, lessonId, "First thought", NOW);
    const later = new Date(NOW.getTime() + 60_000);

    expect(saveNote(db, base.user.id, lessonId, "Second thought", later)).toMatchObject(
      {
        ok: true,
        note: {
          body: "Second thought",
          createdAt: NOW.toISOString(),
          updatedAt: later.toISOString(),
        },
      }
    );
    expect(
      db
        .select()
        .from(schema.notes)
        .where(eq(schema.notes.userId, base.user.id))
        .all()
    ).toHaveLength(1);
  });

  it("refuses a note over the cap and accepts one at exactly the cap", () => {
    const atCap = "a".repeat(MAX_NOTE_LENGTH);
    expect(saveNote(db, base.user.id, lessonId, atCap, NOW).ok).toBe(true);

    const overCap = "a".repeat(MAX_NOTE_LENGTH + 1);
    expect(saveNote(db, base.user.id, lessonId, overCap, NOW)).toMatchObject({
      ok: false,
    });
    expect(getNote(db, base.user.id, lessonId)?.body).toHaveLength(
      MAX_NOTE_LENGTH
    );
  });

  it("deletes the note when saved with an empty body", () => {
    saveNote(db, base.user.id, lessonId, "Something", NOW);

    expect(saveNote(db, base.user.id, lessonId, "   ", NOW)).toMatchObject({
      ok: true,
      note: null,
    });
    expect(getNote(db, base.user.id, lessonId)).toBeUndefined();
  });
});

describe("the Saved lists", () => {
  it("contain only the current student's rows, newest first", () => {
    const other = addStudent("Ben");

    db.insert(schema.bookmarks)
      .values([
        {
          userId: base.user.id,
          lessonId,
          createdAt: new Date(2026, 9, 5).toISOString(),
        },
        {
          userId: base.user.id,
          lessonId: secondLessonId,
          createdAt: new Date(2026, 9, 6).toISOString(),
        },
        {
          userId: other.id,
          lessonId,
          createdAt: new Date(2026, 9, 7).toISOString(),
        },
      ])
      .run();

    saveNote(db, base.user.id, lessonId, "older", new Date(2026, 9, 5));
    saveNote(db, base.user.id, secondLessonId, "newer", new Date(2026, 9, 6));
    saveNote(db, other.id, lessonId, "theirs", new Date(2026, 9, 7));

    const { savedBookmarks, savedNotes } = getSavedForUser(db, base.user.id);

    expect(savedBookmarks.map((row) => row.lessonId)).toEqual([
      secondLessonId,
      lessonId,
    ]);
    expect(savedNotes.map((row) => row.body)).toEqual(["newer", "older"]);
    expect(savedNotes.map((row) => row.lessonId)).toEqual([
      secondLessonId,
      lessonId,
    ]);
  });

  it("name the Lesson and Course each row belongs to", () => {
    toggleBookmark(db, base.user.id, lessonId);
    saveNote(db, base.user.id, lessonId, "A thought", NOW);

    const { savedBookmarks, savedNotes } = getSavedForUser(db, base.user.id);

    expect(savedBookmarks[0]).toMatchObject({
      lessonId,
      lessonTitle: "Lesson 1",
      moduleTitle: "Basics",
      courseTitle: "Test Course",
      courseSlug: "test-course",
    });
    expect(savedNotes[0]).toMatchObject({
      lessonId,
      lessonTitle: "Lesson 1",
      courseTitle: "Test Course",
      courseSlug: "test-course",
      body: "A thought",
    });
  });
});

describe("an approved refund", () => {
  it("keeps the student's bookmarks and notes", async () => {
    db.insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: daysBefore(3),
      })
      .run();
    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();

    toggleBookmark(db, base.user.id, lessonId);
    saveNote(db, base.user.id, lessonId, "Keep me", NOW);

    const purchase = db.select().from(schema.purchases).get();
    if (!purchase) throw new Error("Purchase not found");

    const admin = db
      .insert(schema.users)
      .values({
        name: "Pat Admin",
        email: "pat@example.com",
        role: UserRole.Admin,
      })
      .returning()
      .get();

    const raised = await raiseRefundRequest(
      db,
      purchase.id,
      base.user.id,
      "Nope.",
      NOW,
      notifications
    );
    if (!raised.ok) throw new Error(raised.error);

    const approved = await approveRefundRequest(
      db,
      raised.refundRequestId,
      admin.id,
      null,
      NOW,
      notifications
    );
    expect(approved.ok).toBe(true);

    expect(getBookmark(db, base.user.id, lessonId)).toBeDefined();
    expect(getNote(db, base.user.id, lessonId)?.body).toBe("Keep me");
  });
});
