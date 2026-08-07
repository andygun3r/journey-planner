import { redirect } from "next/navigation";

/** Moved to /admin/timetable — this stub keeps the old bookmarked URL working. */
export default function TimetableSettingsRedirect() {
  redirect("/admin/timetable");
}
