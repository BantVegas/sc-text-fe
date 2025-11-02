
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from "react-router-dom";
import Login from "./pages/Login";
import Compare from "./pages/Compare";

// Strážca routy – ak nie si prihlásený, presmeruje na /login a uloží "from" pre návrat
function RequireAuth() {
  const location = useLocation();
  const ok = localStorage.getItem("etis_auth") === "1";
  return ok ? <Outlet /> : <Navigate to="/login" replace state={{ from: location }} />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* root -> /compare */}
        <Route path="/" element={<Navigate to="/compare" replace />} />

        {/* login je verejný */}
        <Route path="/login" element={<Login />} />

        {/* všetko pod týmto je chránené */}
        <Route element={<RequireAuth />}>
          <Route path="/compare" element={<Compare />} />
        </Route>

        {/* fallback na /compare pri zlej URL */}
        <Route path="*" element={<Navigate to="/compare" replace />} />
      </Routes>
    </BrowserRouter>
  );
}


