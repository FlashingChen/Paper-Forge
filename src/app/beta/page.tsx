import { redirect } from "next/navigation";

/**
 * `/beta` used to be an email-based application page (and is still linked from
 * the odd bookmark or screenshot). Registration now happens in the app, so the
 * old address just forwards there.
 */
export default function BetaPage() {
  redirect("/register");
}
