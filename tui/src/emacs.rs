use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::app::App;

/// Attempts to handle a key event as an Emacs/Readline editing shortcut.
/// Returns `true` if the key was recognized and handled as an Emacs command.
pub fn handle_emacs_key(app: &mut App, key: &KeyEvent, is_input_tall: bool) -> bool {
    let has_ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let has_alt = key.modifiers.contains(KeyModifiers::ALT);

    if has_ctrl && !has_alt {
        match key.code {
            // C-a: Beginning of line (home)
            KeyCode::Char('a') | KeyCode::Char('A') => {
                app.move_cursor_home();
                true
            }
            // C-e: End of line (end)
            KeyCode::Char('e') | KeyCode::Char('E') => {
                app.move_cursor_end();
                true
            }
            // C-f: Forward character (right)
            KeyCode::Char('f') | KeyCode::Char('F') => {
                app.move_cursor_right();
                true
            }
            // C-b: Backward character (left)
            KeyCode::Char('b') | KeyCode::Char('B') => {
                app.move_cursor_left();
                true
            }
            // C-p: Previous line (up)
            KeyCode::Char('p') | KeyCode::Char('P') => {
                if is_input_tall {
                    app.move_cursor_up_line();
                } else {
                    app.scroll_up();
                }
                true
            }
            // C-n: Next line (down)
            KeyCode::Char('n') | KeyCode::Char('N') => {
                if is_input_tall {
                    app.move_cursor_down_line();
                } else {
                    app.scroll_down();
                }
                true
            }
            // C-d: Delete character forward (delete)
            KeyCode::Char('d') | KeyCode::Char('D') => {
                app.delete();
                true
            }
            // C-h: Backward delete character (backspace)
            KeyCode::Char('h') | KeyCode::Char('H') => {
                app.backspace();
                true
            }
            // C-k: Kill from cursor to end of line
            KeyCode::Char('k') | KeyCode::Char('K') => {
                app.clear_to_end_of_line();
                true
            }
            // C-u: Unix line discard (clear entire line / to beginning)
            KeyCode::Char('u') | KeyCode::Char('U') => {
                app.clear_line();
                true
            }
            // C-w: Backward kill word
            KeyCode::Char('w') | KeyCode::Char('W') => {
                app.delete_word();
                true
            }
            _ => false,
        }
    } else if has_alt && !has_ctrl {
        match key.code {
            // M-b (Alt+B): Move cursor backward one word
            KeyCode::Char('b') | KeyCode::Char('B') => {
                app.move_cursor_word_left();
                true
            }
            // M-f (Alt+F): Move cursor forward one word
            KeyCode::Char('f') | KeyCode::Char('F') => {
                app.move_cursor_word_right();
                true
            }
            // M-d (Alt+D): Kill word forward
            KeyCode::Char('d') | KeyCode::Char('D') => {
                app.delete_word_forward();
                true
            }
            _ => false,
        }
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyEventKind;

    fn make_app() -> App {
        App::new(crate::api::CascadeClient::new("http://127.0.0.1:1".into(), None))
    }

    fn ctrl_key(c: char) -> KeyEvent {
        KeyEvent {
            code: KeyCode::Char(c),
            modifiers: KeyModifiers::CONTROL,
            kind: KeyEventKind::Press,
            state: crossterm::event::KeyEventState::empty(),
        }
    }

    fn alt_key(c: char) -> KeyEvent {
        KeyEvent {
            code: KeyCode::Char(c),
            modifiers: KeyModifiers::ALT,
            kind: KeyEventKind::Press,
            state: crossterm::event::KeyEventState::empty(),
        }
    }

    #[test]
    fn test_emacs_ctrl_shortcuts() {
        let mut app = make_app();
        app.input = "hello world".into();
        app.cursor_pos = 5;

        // C-a -> Home
        assert!(handle_emacs_key(&mut app, &ctrl_key('a'), false));
        assert_eq!(app.cursor_pos, 0);

        // C-e -> End
        assert!(handle_emacs_key(&mut app, &ctrl_key('e'), false));
        assert_eq!(app.cursor_pos, 11);

        // C-b -> Left
        assert!(handle_emacs_key(&mut app, &ctrl_key('b'), false));
        assert_eq!(app.cursor_pos, 10);

        // C-f -> Right
        assert!(handle_emacs_key(&mut app, &ctrl_key('f'), false));
        assert_eq!(app.cursor_pos, 11);

        // C-w -> Kill word backward
        assert!(handle_emacs_key(&mut app, &ctrl_key('w'), false));
        assert_eq!(app.input, "hello ");
        assert_eq!(app.cursor_pos, 6);

        // C-k -> Kill to end of line
        app.cursor_pos = 2;
        assert!(handle_emacs_key(&mut app, &ctrl_key('k'), false));
        assert_eq!(app.input, "he");
        assert_eq!(app.cursor_pos, 2);

        // C-u -> Clear line
        assert!(handle_emacs_key(&mut app, &ctrl_key('u'), false));
        assert_eq!(app.input, "");
        assert_eq!(app.cursor_pos, 0);
    }

    #[test]
    fn test_emacs_alt_b_and_alt_f_word_navigation() {
        let mut app = make_app();
        app.input = "the quick brown fox".into();
        app.cursor_pos = 0;

        // Alt+F forward word by word
        assert!(handle_emacs_key(&mut app, &alt_key('f'), false));
        assert_eq!(app.cursor_pos, 3); // after "the"

        assert!(handle_emacs_key(&mut app, &alt_key('f'), false));
        assert_eq!(app.cursor_pos, 9); // after "quick"

        assert!(handle_emacs_key(&mut app, &alt_key('f'), false));
        assert_eq!(app.cursor_pos, 15); // after "brown"

        assert!(handle_emacs_key(&mut app, &alt_key('f'), false));
        assert_eq!(app.cursor_pos, 19); // after "fox"

        // Alt+B backward word by word
        assert!(handle_emacs_key(&mut app, &alt_key('b'), false));
        assert_eq!(app.cursor_pos, 16); // before "fox"

        assert!(handle_emacs_key(&mut app, &alt_key('b'), false));
        assert_eq!(app.cursor_pos, 10); // before "brown"

        assert!(handle_emacs_key(&mut app, &alt_key('b'), false));
        assert_eq!(app.cursor_pos, 4); // before "quick"

        assert!(handle_emacs_key(&mut app, &alt_key('b'), false));
        assert_eq!(app.cursor_pos, 0); // before "the"

        // Alt+D kill word forward
        assert!(handle_emacs_key(&mut app, &alt_key('d'), false));
        assert_eq!(app.input, " quick brown fox");
        assert_eq!(app.cursor_pos, 0);
    }
}
