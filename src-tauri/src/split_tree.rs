/* ---------------- pane layout tree for split terminal tabs ----------------
Rust port of src/shared/split-tree.ts. A tab holds a binary tree of
shells: leaves are pty ids, internal nodes are split axes ('v' = side
by side, 'h' = stacked). The serde representation is tag-compatible
with the renderer's TypeScript mirror: {"kind":"leaf","id":..} and
{"kind":"split","key":..,"dir":"v"|"h","first":..,"second":..}. */

use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind")]
pub enum PaneNode {
    #[serde(rename = "leaf")]
    Leaf { id: String },
    #[serde(rename = "split")]
    Split {
        key: String,
        dir: Dir,
        first: Box<PaneNode>,
        second: Box<PaneNode>,
    },
}

/* 'v' = side by side, 'h' = stacked; serialized as the lowercase
letters the renderer uses */
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    #[serde(rename = "v")]
    V,
    #[serde(rename = "h")]
    H,
}

pub fn leaf_node(id: &str) -> PaneNode {
    PaneNode::Leaf { id: id.to_string() }
}

static KEY_SEQ: AtomicU32 = AtomicU32::new(0);

/* caller supplies keys when splitting so main and renderer name the new
node identically without an extra round-trip */
pub fn new_node_key() -> String {
    let seq = KEY_SEQ.fetch_add(1, Ordering::Relaxed);
    let millis = chrono::Utc::now().timestamp_millis().max(0) as u64;
    let rnd: u32 = rand::thread_rng().gen();
    format!(
        "s-{}-{}{:05x}",
        to_base36(millis),
        to_base36(seq as u64),
        rnd & 0xfffff
    )
}

pub(crate) fn to_base36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

pub fn leaf_ids(t: &PaneNode) -> Vec<String> {
    match t {
        PaneNode::Leaf { id } => vec![id.clone()],
        PaneNode::Split { first, second, .. } => {
            let mut ids = leaf_ids(first);
            ids.extend(leaf_ids(second));
            ids
        }
    }
}

pub fn first_leaf_id(t: &PaneNode) -> &str {
    match t {
        PaneNode::Leaf { id } => id,
        PaneNode::Split { first, .. } => first_leaf_id(first),
    }
}

pub fn tree_has_leaf(t: &PaneNode, id: &str) -> bool {
    match t {
        PaneNode::Leaf { id: leaf } => leaf == id,
        PaneNode::Split { first, second, .. } => {
            tree_has_leaf(first, id) || tree_has_leaf(second, id)
        }
    }
}

pub fn tree_has_key(t: &PaneNode, key: &str) -> bool {
    match t {
        PaneNode::Leaf { .. } => false,
        PaneNode::Split {
            key: k,
            first,
            second,
            ..
        } => k == key || tree_has_key(first, key) || tree_has_key(second, key),
    }
}

/* divide the pane `pane_id` in two; no-op on non-matching leaves */
pub fn split_leaf(t: PaneNode, pane_id: &str, dir: Dir, new_id: &str, key: &str) -> PaneNode {
    split_leaf_at(t, pane_id, dir, new_id, key, false)
}

/* `before` puts the new pane first (up/left), default appends after (right/down) */
pub fn split_leaf_at(t: PaneNode, pane_id: &str, dir: Dir, new_id: &str, key: &str, before: bool) -> PaneNode {
    match t {
        PaneNode::Leaf { id } => {
            if id == pane_id {
                let (first, second) = if before {
                    (leaf_node(new_id), PaneNode::Leaf { id })
                } else {
                    (PaneNode::Leaf { id }, leaf_node(new_id))
                };
                PaneNode::Split {
                    key: key.to_string(),
                    dir,
                    first: Box::new(first),
                    second: Box::new(second),
                }
            } else {
                PaneNode::Leaf { id }
            }
        }
        PaneNode::Split {
            key: k,
            dir: d,
            first,
            second,
        } => PaneNode::Split {
            key: k,
            dir: d,
            first: Box::new(split_leaf_at(*first, pane_id, dir, new_id, key, before)),
            second: Box::new(split_leaf_at(*second, pane_id, dir, new_id, key, before)),
        },
    }
}

/* remove a leaf; the enclosing axis collapses to its surviving branch.
Returns None when the last leaf goes away. */
pub fn remove_leaf(t: PaneNode, pane_id: &str) -> Option<PaneNode> {
    match t {
        PaneNode::Leaf { id } => {
            if id == pane_id {
                None
            } else {
                Some(PaneNode::Leaf { id })
            }
        }
        PaneNode::Split {
            key,
            dir,
            first,
            second,
        } => {
            let new_first = remove_leaf(*first, pane_id);
            let first = match new_first {
                Some(f) => f,
                None => return Some(*second),
            };
            let second = match remove_leaf(*second, pane_id) {
                Some(s) => s,
                None => return Some(first),
            };
            Some(PaneNode::Split {
                key,
                dir,
                first: Box::new(first),
                second: Box::new(second),
            })
        }
    }
}

pub fn set_split_dir(t: PaneNode, key: &str, dir: Dir) -> PaneNode {
    match t {
        leaf @ PaneNode::Leaf { .. } => leaf,
        PaneNode::Split {
            key: k,
            dir: d,
            first,
            second,
        } => {
            let (k, d) = if k == key { (k, dir) } else { (k, d) };
            PaneNode::Split {
                key: k,
                dir: d,
                first: Box::new(set_split_dir(*first, key, dir)),
                second: Box::new(set_split_dir(*second, key, dir)),
            }
        }
    }
}

/* fresh pty ids after a relaunch: rewrite leaves through the map */
pub fn remap_leaves(t: PaneNode, map: &HashMap<String, String>) -> PaneNode {
    match t {
        PaneNode::Leaf { id } => PaneNode::Leaf {
            id: map.get(&id).cloned().unwrap_or(id),
        },
        PaneNode::Split {
            key,
            dir,
            first,
            second,
        } => PaneNode::Split {
            key,
            dir,
            first: Box::new(remap_leaves(*first, map)),
            second: Box::new(remap_leaves(*second, map)),
        },
    }
}

/* one-off migration for tabs persisted before layout trees existed */
pub fn tree_from_legacy(ids: &[String], dir: Option<Dir>) -> Option<PaneNode> {
    let first = ids.first()?;
    let mut t = leaf_node(first);
    let d = dir.unwrap_or(Dir::V);
    for id in &ids[1..] {
        t = PaneNode::Split {
            key: new_node_key(),
            dir: d,
            first: Box::new(t),
            second: Box::new(leaf_node(id)),
        };
    }
    Some(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    /* compact structural printout: "(first DIR second)", leaves as their id */
    fn shape(x: &PaneNode) -> String {
        match x {
            PaneNode::Leaf { id } => id.clone(),
            PaneNode::Split {
                dir, first, second, ..
            } => format!(
                "({} {} {})",
                shape(first),
                match dir {
                    Dir::V => "v",
                    Dir::H => "h",
                },
                shape(second)
            ),
        }
    }

    #[test]
    fn test_split_before_puts_new_pane_first() {
        let t = split_leaf_at(leaf_node("a"), "a", Dir::V, "b", "k1", true);
        assert_eq!(shape(&t), "(b v a)");
        assert_eq!(leaf_ids(&t), vec!["b".to_string(), "a".to_string()]);
        assert_eq!(first_leaf_id(&t), "b");
    }

    #[test]
    fn test_two_panes_and_nested_split() {
        let t = split_leaf(leaf_node("a"), "a", Dir::V, "b", "k1");
        assert_eq!(shape(&t), "(a v b)");
        let t = split_leaf(t, "b", Dir::H, "c", "k2");
        assert_eq!(shape(&t), "(a v (b h c))");
    }

    #[test]
    fn test_leaf_order_first_leaf_and_membership() {
        let t = split_leaf(leaf_node("a"), "a", Dir::V, "b", "k1");
        let t = split_leaf(t, "b", Dir::H, "c", "k2");
        assert_eq!(
            leaf_ids(&t),
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
        assert_eq!(first_leaf_id(&t), "a");
        assert!(tree_has_leaf(&t, "c"));
        assert!(!tree_has_leaf(&t, "z"));
        assert!(tree_has_key(&t, "k1"));
        assert!(tree_has_key(&t, "k2"));
        assert!(!tree_has_key(&t, "nope"));
    }

    #[test]
    fn test_resplit_and_four_leaves() {
        let t = split_leaf(leaf_node("a"), "a", Dir::V, "b", "k1");
        let t = split_leaf(t, "b", Dir::H, "c", "k2");
        let t = split_leaf(t, "a", Dir::H, "d", "k3");
        assert_eq!(shape(&t), "((a h d) v (b h c))");
        assert_eq!(leaf_ids(&t), vec!["a", "d", "b", "c"]);
    }

    #[test]
    fn test_remove_middle_collapses_axis() {
        let t = split_leaf(leaf_node("a"), "a", Dir::V, "b", "k1");
        let t = split_leaf(t, "b", Dir::H, "c", "k2");
        let t = split_leaf(t, "a", Dir::H, "d", "k3");
        let r1 = remove_leaf(t.clone(), "b").unwrap();
        assert_eq!(shape(&r1), "((a h d) v c)");
        let x = remove_leaf(t.clone(), "zz").unwrap();
        assert_eq!(shape(&x), shape(&t));
    }

    #[test]
    fn test_anchor_removal_and_last_leaf_null() {
        let t = split_leaf(leaf_node("a"), "a", Dir::V, "b", "k1");
        let t = split_leaf(t, "b", Dir::H, "c", "k2");
        let t = split_leaf(t, "a", Dir::H, "d", "k3");
        let r1 = remove_leaf(t, "b").unwrap();
        let r2 = remove_leaf(r1, "d").unwrap();
        assert_eq!(shape(&r2), "(a v c)");
        assert_eq!(first_leaf_id(&r2), "a");
        let ra = remove_leaf(r2, "a").unwrap();
        let rc = remove_leaf(ra, "c");
        assert!(rc.is_none());
    }

    #[test]
    fn test_set_split_dir_flips_target_only() {
        let t = split_leaf(leaf_node("a"), "a", Dir::V, "b", "k1");
        let t = split_leaf(t, "b", Dir::H, "c", "k2");
        let t = split_leaf(t, "a", Dir::H, "d", "k3");
        let f = set_split_dir(t, "k2", Dir::V);
        assert_eq!(shape(&f), "((a h d) v (b v c))");
    }

    #[test]
    fn test_remap_leaves_keeps_shape_and_keys() {
        let t = split_leaf(leaf_node("a"), "a", Dir::V, "b", "k1");
        let t = split_leaf(t, "b", Dir::H, "c", "k2");
        let t = split_leaf(t, "a", Dir::H, "d", "k3");
        let map: HashMap<String, String> = [("a", "A"), ("b", "B"), ("c", "C"), ("d", "D")]
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let m = remap_leaves(t.clone(), &map);
        assert_eq!(shape(&m), "((A h D) v (B h C))");
        assert_eq!(leaf_ids(&m), vec!["A", "D", "B", "C"]);
    }

    #[test]
    fn test_legacy_migration() {
        let ids: Vec<String> = vec!["p1".into(), "p2".into(), "p3".into()];
        let leg = tree_from_legacy(&ids, Some(Dir::H)).unwrap();
        assert_eq!(leaf_ids(&leg), ids);
        assert!(matches!(leg, PaneNode::Split { dir: Dir::H, .. }));
        let only = tree_from_legacy(&["only".to_string()], None).unwrap();
        assert_eq!(only, leaf_node("only"));
    }

    #[test]
    fn test_new_node_key_unique() {
        let keys: Vec<String> = (0..50).map(|_| new_node_key()).collect();
        let uniq: std::collections::HashSet<&String> = keys.iter().collect();
        assert_eq!(uniq.len(), 50);
        assert!(keys.iter().all(|k| k.starts_with("s-")));
    }

    /* serde JSON must stay tag-compatible with the renderer's TS mirror */
    #[test]
    fn test_serde_matches_renderer_json() {
        let leaf: serde_json::Value = serde_json::to_value(leaf_node("a")).unwrap();
        assert_eq!(leaf, serde_json::json!({ "kind": "leaf", "id": "a" }));

        let t = split_leaf(leaf_node("a"), "a", Dir::H, "b", "k1");
        let v: serde_json::Value = serde_json::to_value(&t).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "kind": "split", "key": "k1", "dir": "h",
                "first": { "kind": "leaf", "id": "a" },
                "second": { "kind": "leaf", "id": "b" }
            })
        );

        let restored: PaneNode = serde_json::from_value(v).unwrap();
        assert_eq!(restored, t);
    }
}
