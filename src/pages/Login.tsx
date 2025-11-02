import { useState } from "react";
import { useNavigate } from "react-router-dom";

export default function Login() {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const navigate = useNavigate();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");

    // pevné prihlasovanie
    const ok = user.trim().toLowerCase() === "kontrola" && pass === "etis1";
    if (!ok) {
      setErr("Nesprávne meno alebo heslo.");
      return;
    }

    localStorage.setItem("etis_auth", "1");
    localStorage.setItem("etis_user", "kontrola");
    navigate("/compare", { replace: true });
  }

  const canSubmit = user.trim().length > 0 && pass.length > 0;

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-slate-800/70 backdrop-blur rounded-2xl border border-slate-700 shadow-xl p-8">
        {/* Logo preč – ponecháme len titulok */}
        <h1 className="text-center text-slate-100 text-2xl font-bold">GPCS ScanControll</h1>
        <p className="text-center text-slate-400 mt-1">Prihlásenie</p>

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <div>
            <label className="block text-slate-300 text-sm mb-1">Používateľ</label>
            <input
              className="w-full rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="kontrola"
              autoFocus
              value={user}
              onChange={(e) => setUser(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-slate-300 text-sm mb-1">Heslo</label>
            <input
              className="w-full rounded-lg bg-slate-900/70 border border-slate-700 px-3 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="•••••"
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
            />
          </div>

          {err && (
            <div className="text-sm text-red-400 bg-red-900/20 border border-red-700 rounded-lg px-3 py-2">
              {err}
            </div>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold py-2.5 transition"
          >
            Prihlásiť sa
          </button>
        </form>
      </div>
    </div>
  );
}

