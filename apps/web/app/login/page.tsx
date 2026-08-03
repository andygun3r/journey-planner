import { LoginForm } from "@/components/login-form";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <main>
      <div className="results-head">
        <h1>Sign in</h1>
      </div>
      <LoginForm />
    </main>
  );
}
