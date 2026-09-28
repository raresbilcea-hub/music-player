"use client";

import Link from "next/link";
import { useAuth } from "../context/auth";
import styles from "./AuthHeader.module.css";

export function AuthHeader() {
  const { user, loading, signOut } = useAuth();

  return (
    <nav className={styles.nav}>
      <div className={styles.inner}>
        <Link href="/" className={styles.logo}>
          Music Player <span>2.0</span>
        </Link>
        <div className={styles.right}>
          {!loading &&
            (user ? (
              <>
                <Link href="/history" className={styles.link}>
                  History
                </Link>
                <span className={styles.email}>{user.email}</span>
                <button className={styles.signOut} onClick={() => signOut()}>
                  Sign out
                </button>
              </>
            ) : (
              <>
                <Link href="/login" className={styles.link}>
                  Sign in
                </Link>
                <Link href="/register" className={styles.linkPrimary}>
                  Sign up free
                </Link>
              </>
            ))}
        </div>
      </div>
    </nav>
  );
}
