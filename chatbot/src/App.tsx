import { Routes, Route, Navigate } from 'react-router';
import ChatPage from '@/pages/chat';

function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/chat" replace />} />
      <Route path="/chat" element={<ChatPage />} />
    </Routes>
  );
}

export default App;
