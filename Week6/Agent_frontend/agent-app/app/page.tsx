'use client';

import { useState, useRef, useEffect } from 'react';

type Message = {
  role: 'user' | 'agent';
  content: string;
};

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const sendMessage = async () => {
    if (!input.trim() || loading) return;

    const userMessage: Message = {
      role: 'user',
      content: input,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage.content }),
      });

      const data = await res.json();

      const agentMessage: Message = {
        role: 'agent',
        content: data.message || 'No response from agent.',
      };

      setMessages((prev) => [...prev, agentMessage]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'agent', content: 'Error talking to agent.' },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex h-screen bg-zinc-900 text-zinc-100">
      <div className="flex flex-col w-full max-w-4xl mx-auto">

        {/* Header */}
        <header className="p-4 border-b border-zinc-700 text-lg font-semibold">
          🧠 Bedrock Agent Chat
        </header>

        {/* Chat messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((msg, idx) => (
            <div
              key={idx}
              className={`flex ${
                msg.role === 'user' ? 'justify-end' : 'justify-start'
              }`}
            >
              <div
                className={`max-w-[80%] rounded-xl px-4 py-3 text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white'
                    : 'bg-zinc-800 text-zinc-100'
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-zinc-800 px-4 py-3 rounded-xl text-sm opacity-70">
                Agent is thinking…
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Input area */}
        <div className="p-4 border-t border-zinc-700 flex gap-2">
          <input
            type="text"
            placeholder="Ask something…"
            className="flex-1 rounded-lg bg-zinc-800 px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-600"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
          />

          <button
            onClick={sendMessage}
            disabled={loading}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </main>
  );
}
