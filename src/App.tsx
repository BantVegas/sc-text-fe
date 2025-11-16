// src/App.tsx
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Outlet,
  useLocation,
} from "react-router-dom";
import Login from "./pages/Login";
import Compare from "./pages/Compare";

// chránená routa: pustí ďalej len keď je etis_auth === "1"
function RequireAuth() {
  const location = useLocation();
  const ok = typeof window !== "undefined" && localStorage.getItem("etis_auth") === "1";

  if (!ok) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location }}
      />
    );
  }

  return <Outlet />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* ROOT – vždy na login */}
        <Route path="/" element={<Navigate to="/login" replace />} />

        {/* verejný login */}
        <Route path="/login" element={<Login />} />

        {/* chránené routy */}
        <Route element={<RequireAuth />}>
          <Route path="/compare" element={<Compare />} />
        </Route>

        {/* fallback – pri zlej URL tiež na login */}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}



