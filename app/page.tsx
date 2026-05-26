import { Tabs } from "./components/tabs";
import { ChangelogPopup } from "./components/changelog-popup";
import { getImageTiles } from "./lib/images";
import { Github } from "lucide-react";

export default async function Home() {
	const images = await getImageTiles();

	return (
		<div className="min-h-screen p-4">
			<div className="flex items-center justify-center gap-4 mb-8">
				<h1 className="text-3xl font-bold text-center">
					Arena God Tracker
				</h1>
				<a
					href="https://github.com/JustTrott/arena-god"
					target="_blank"
					rel="noopener noreferrer"
					className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
				>
					<Github className="w-6 h-6" />
				</a>
			</div>
			<Tabs images={images} />
			<ChangelogPopup />
		</div>
	);
}
