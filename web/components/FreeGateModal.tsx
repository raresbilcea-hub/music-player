"use client";

import Link from "next/link";
import styles from "./FreeGateModal.module.css";

export function FreeGateModal() {
  return (
    <div className={styles.overlay}>
      <div className={styles.sheet}>
        <div className={styles.icon}>♪</div>
        <h2 className={styles.title}>You&apos;ve used your 3 free songs</h2>
        <p className={styles.body}>
          Create a free account to unlock unlimited chord charts, save your
          history across devices, and correct any chart.
        </p>
        <Link href="/register" className={styles.primary}>
          Create free account
        </Link>
        <Link href="/login" className={styles.secondary}>
          Sign in
        </Link>
      </div>
    </div>
  );
}
