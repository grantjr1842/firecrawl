/**
 * Root page — redirects to /health. The dashboard skeleton is "the
 * /health page works"; the rest of the operator surface is the
 * multi-week followup.
 */
import { redirect } from "next/navigation";

export default function HomePage(): never {
  redirect("/health");
}
