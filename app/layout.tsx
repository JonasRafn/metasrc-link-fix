import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { PostHogProvider } from "./providers";
import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';
import "./globals.css";

const geistSans = Geist({
	variable: "--font-geist-sans",
	subsets: ["latin"],
});

const geistMono = Geist_Mono({
	variable: "--font-geist-mono",
	subsets: ["latin"],
});

export const metadata: Metadata = {
	title: "Arena God Tracker",
	description:
		"Allows you to track your progress in achieving the Arena God title. Automatically tracks your wins in arena too.",
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en" className="dark">
			<body
				className={`${geistSans.variable} ${geistMono.variable} antialiased`}
			>
				<PostHogProvider>{children}</PostHogProvider>
				<Analytics />
				<SpeedInsights />
			</body>
		</html>
	);
}

