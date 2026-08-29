// Fill these in from Supabase Studio -> Settings -> API
const SUPABASE_URL = 'https://your-project-ref.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_1UjLC8U1U2Xs1Az0jTip6A__TZUDzyn';

// `supabase` here is the global provided by the CDN <script> tag.
// We name our instance `supabaseClient` so it doesn't shadow that global.
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// Creates a brand new account. Supabase may require the user to click some stuff
async function signUpWithEmail(email, password) {
    const { data, error } = await supabaseClient.auth.signUp({ email, password });
    return { data, error };
}

// Logs an existing user in.
async function signInWithEmail(email, password) {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    return { data, error };
}

async function signOut() {
    await supabaseClient.auth.signOut();
    window.location.reload();
}

// Call this on page load wherever you have an element with id="auth-area"
async function renderAuthArea() {
    const authArea = document.getElementById('auth-area');
    const signOutButton = document.getElementById('sign-out-btn');
    if (!authArea) return;

    const { data: { session } } = await supabaseClient.auth.getSession();

    if (session) {
        authArea.href="";
        authArea.innerHTML = `
            ${session.user.email.split('@')[0]}
        `;
        signOutButton.style.display = "block";

    } else {
        authArea.innerHTML = `Sign in`;
        authArea.href = "login.html";
        signOutButton.style.display = "none";
    }
}

renderAuthArea();