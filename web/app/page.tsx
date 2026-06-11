import { RecordButton } from "../components/RecordButton";
import { SearchBox } from "../components/SearchBox";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main>
      <header className={styles.header}>
        <h1 className={styles.logo}>
          Music Player <span>2.0</span>
        </h1>
        <p className={styles.tagline}>
          Real chords, detected from the actual recording.
        </p>
      </header>

      <RecordButton />

      <div className={styles.divider}>or search by name</div>

      <SearchBox />
    </main>
  );
}
