## **Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite** 

S´ebastien Hillaire _EA Frostbite_ 

1 

## **Contents** 

|**1**|**Introduction**|**Introduction**||**4**|
|---|---|---|---|---|
||1.1|Context . . . . . . . .|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|4|
||1.2|Scope and objective<br>.|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|5|
||1.3|Contributors<br>. . . . .|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|6|
|**2**|**Participating Media**|||**8**|
||2.1|Single scattering<br>. . .|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|9|
||2.2|Albedo . . . . . . . . .|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|11|
||2.3|Phase function<br>. . . .|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|11|
|||2.3.1<br>Isotropic scattering phase . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .||11|
|||2.3.2<br>Rayleigh scattering phase . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .||12|
|||2.3.3<br>Mie scattering phase . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .||12|
|||2.3.4<br>Geometric scattering phase . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .||13|
||2.4|Examples . . . . . . .|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|13|
||2.5|Related chapters . . .|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|16|
|**3**|**Sky **|**and Atmosphere**||**17**|
||3.1|Previous work . . . . .|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|17|
||3.2|Sky and atmosphere participating media defnition . . . . . . . . . . . . . . . . . . . . .||18|
||3.3|Atmosphere composition . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .||18|
||3.4|Ozone absorption . . .|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|20|
||3.5|Our approach . . . . .|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|21|
|||3.5.1<br>Performance<br>.|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|22|
|||3.5.2<br>Results<br>. . . .|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|22|
|**4**|**Sun, Moon and Stars**|||**25**|
||4.1|Sun<br>. . . . . . . . . .|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|25|
|||4.1.1<br>Sun illuminance|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|25|
|||4.1.2<br>Sun luminance|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|26|
|||4.1.3<br>Limb darkening|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|28|
||4.2|Moon<br>. . . . . . . . .|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|28|
||4.3|Stars . . . . . . . . . .|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|29|
||4.4|Results. . . . . . . . .|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|29|
|**5**|**Clouds**|||**30**|
||5.1|Background and Previous work . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .||30|
||5.2|Cloud participating media material . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .||32|
||5.3|Cloud authoring<br>. . .|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|32|
|||5.3.1<br>Cloud distribution and density . . . . . . . . . . . . . . . . . . . . . . . . . . . .||33|
||5.4|Cloud noise . . . . . .|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|34|
|||5.4.1<br>Cloud material|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|35|
||5.5|Cloud rendering. . . .|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|35|
|||5.5.1<br>Ambient lighting . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .||35|
|||5.5.2<br>Sun shadow sampling<br>. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .||36|
|||5.5.3<br>Temporal scattering integration . . . . . . . . . . . . . . . . . . . . . . . . . . . .||36|
||5.6|Improved scattering<br>.|. . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|37|
|||5.6.1<br>Usual scattering|integration . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .|37|
|||5.6.2<br>Better numerical integrations . . . . . . . . . . . . . . . . . . . . . . . . . . . . .||38|



2 

|||5.6.3<br>Energy-conserving analytical integration . . . . . . . . . . . . . . . . . . . . . . .|5.6.3<br>Energy-conserving analytical integration . . . . . . . . . . . . . . . . . . . . . . .|38|
|---|---|---|---|---|
||5.7|Cloud phase function . . . . . . . . . . . .|. . . . . . . . . . . . . . . . . . . . . . . . . .|39|
||5.8|Multiple scattering . . . . . . . . . . . . .|. . . . . . . . . . . . . . . . . . . . . . . . . .|41|
||5.9|Other interactions<br>. . . . . . . . . . . . .|. . . . . . . . . . . . . . . . . . . . . . . . . .|42|
|||5.9.1<br>Aerial perspective afecting clouds|. . . . . . . . . . . . . . . . . . . . . . . . . .|43|
|||5.9.2<br>Clouds afecting aerial perspective|. . . . . . . . . . . . . . . . . . . . . . . . . .|43|
||5.10|Performance . . . . . . . . . . . . . . . . .|. . . . . . . . . . . . . . . . . . . . . . . . . .|45|
||5.11|Results. . . . . . . . . . . . . . . . . . . .|. . . . . . . . . . . . . . . . . . . . . . . . . .|45|
|**6**|**Conclusion**|||**50**|
||6.1|Future work . . . . . . . . . . . . . . . . .|. . . . . . . . . . . . . . . . . . . . . . . . . .|51|
|**A **|**Sky **|**look-up table parametrization**||**57**|
|**B **|**Sun **|**limb darkening astro-physical models**||**60**|
|**C **|**Energy-conserving analytical scattering integration**|||**61**|
|**D **|**Tile-able volume noise library**|||**62**|



3 

## **1 Introduction** 

Video games are becoming more and more demanding in terms of visual quality and dynamism. Open world games, for instance, may require lots of dynamic elements, such as _time of day_ lighting and realtime evolving weather. The dynamic and often global nature of these elements make them difficult to simulate and render in real time. Sky, atmosphere and clouds are the three main components we need to simulate in order to achieve dynamic time of day and weather conditions. They are difficult to render due to their very detailed and specific volumetric nature. These elements also interact together, such as clouds affecting atmospheric lighting and vice versa. 

In this document, we present the practical physically based solutions we have researched and developed for Frostbite to simulate and combine of all these elements, as well as to render the complex interactions between them. We will also describe how this fits into Frostbite’s physically based shading framework as well as how artists author such elements (for both released and currently in production titles), along with their performance characteristics. 

## **1.1 Context** 

In 2014, Frostbite[1] was significantly evolved to become a physically based rendering engine [LR14]. Among other things, this resulted in decoupled light and material definitions, which changed the way they are specified by artists as well as how they interact. These changes permeated all the way up to the camera receptors and the way that lighting information is transformed and presented on screen. This resulted in a huge increase in visual quality, as demonstrated in Figure 1. It can be hard to tell which picture is real or computer generated: left or right? 

Figure 1: Need for speed [Gho17] comparisons: _reality_ versus _Frostbite engine_ . Can you guess which is which? 

Taking a physically based approach with decoupled lighting and material information means that once a material has been authored, it should look consistent under any lighting condition. This is 

> 1Frostbite is a game development platform that powers most titles at Electronic Arts (EA). See `http://www. frostbite.com` for details. 

4 

especially relevant to us now that a lot of EA titles are more _open world_ in nature, with time of day and dynamic weather. However, at the time, Frostbite’s sky, fog, cloud and participating media systems were still very static elements that could only be linearly blended. These elements included the panoramic sky texture, sky color gradient, fog color, fog curves, etc. It was time consuming for artists to ensure that all of these colors and curves were consistent for each time of day, especially as each state can be linearly interpolated and contain high dynamic range content. It is also lots of time to invest when re-authoring is required after art direction feedback. There was nothing inherently wrong with these techniques since they did allow games such as _Battlefield 4_ and _Star Wars Battlefront_ to looks gorgeous (Figure 2). That being said, more advanced solutions were needed to enable games to support more dynamic use cases. 

Figure 2: Top and bottom: Battlefield 4 [DIC13] and Star Wars[TM] Battlefront [DIC15]. 

## **1.2 Scope and objective** 

Figure 3 represents what we wanted game artists to be able to achieve in Frostbite: 

5 

Figure 3: Aerial perspective photo featuring sky and atmosphere scattering, sun and clouds. (Photo by David Iliff. License: CC-BY-SA 3.0.) 

- a realistic sky supporting dynamic time of day 

- dynamic lighting according to the sun position 

- atmospheric scattering 

- clouds evolving according to the weather 

We wanted these techniques to be scalable in order to be used by both 30 and 60 FPS titles. We also wanted these new techniques to fit within Frostbite’s physically based framework. This meant decoupling lighting parameters from material representation, and using physically based parametrizations to represent real physical properties of participating media materials. 

Additionally, many EA games need to reach a stable 60 frames per second, with high visual quality. This is already challenging by itself but shipping games with that constraint while having dynamic time of day and weather is a lot more complex. Especially when you want all of the different systems to stay synchronized between each other. 

Also, we wanted all these visual features to interact together coherently, and be as realistic and unified as possible by default, across participating media, opaque and transparent materials. For instance, clouds becoming larger and thicker should affect the light scattered through the atmosphere, as well as sun shadows, which in turn also affects global illumination and thus global reflection on transparent surfaces, etc. 

## **1.3 Contributors** 

The work presented in this document is the result of many collaborations between Frostbite, master students as well as game team engineers and artists. 

Concerning the sky and atmosphere systems, we would like to thanks Gustav Bodare (Ghost) and Edvard Sandberg (Ghost) who were master student in 2014, Bioware (Mass Effect Andromeda[TM] ), DICE (Mirror’s Edge Catalyst[TM] ), Ghost (Need for Speed[TM] ). 

Concerning the volumetric cloud systems, we would like to thanks Rurik H¨ogfeldt (2015 Master student) as well as Bioware: Marc-Andre Loyer (Programmer), Soren Hesse (Tech Environment Art) and Don Arceta (Lead Environment Art). 

Thanks to Per Einarsson, Charles de Rousiers and Tomasz Stachowiak and the Frostbite rendering team for all the discussion and help about those rendering techniques. 

6 

Thanks to the rendering research community for sharing such incredible knowledge, useful research and practical result. And with source code sometime! Please continue to do so. Thanks to Fabrice Neyret, Eric Bruneton and Antoine Bouthors for the discussion around sky and cloud rendering. 

Last but not the least, thanks To Stephen Hill and Stephen McAuley for their help during the SIGGRAPH 2016 _Physically Based Shading in Theory and Practice_ course [MH16] preparation, presentation and the review of this document. 

7 

## **2 Participating Media** 

Participating media is the term used to describe volumes filled with particles. Such particles can be large impurities, _e.g._ dust, pollution, water droplets, or simply particles, _e.g._ molecules. Depending on its composition, the media will interact differently with light traveling through it and bouncing on particles, typically referred to as _light scattering_ . The density of particles per volume can also vary spatially and take different form at different scale. For instance, in the case of water droplets, a wide and light density distribution volume could represent uniform fog, _i.e._ homogeneous media, whereas locally dense volume could represent clouds, _i.e._ heterogeneous media. 

In this document, we will focus on participating media represented with spherical particles of varying radius. We will not discuss about micro flakes representation and theory. This means we assume isotropic participating media, _i.e._ scattering probability does not depend on incoming light direction, while still allowing asymmetric scattering, i.e. the scatter amount depends on the incoming light direction and is driven by the phase function (see Section 2.3). We will also ignore participating media emitting light, _e.g._ black body simulation. The notations used in this document are presented in Table 1. 

|**Symbol**|**description**|**unit**|
|---|---|---|
|_σa_<br>_σs_<br>_σt_<br>_ρ_<br>_p_<br>_L_<br>_L_(_x, ω_)<br>_E_|absorption coefficient<br>scattering coefficient<br>extinction coefficient<br>albedo<br>phase function<br>luminance<br>luminance at point x in direction _ω_<br>illuminance|_m−_1<br>_m−_1<br>_m−_1<br>unitless<br>_sr−_1<br>_cd.m−_2<br>_cd.m−_2<br>_cd.sr−_1_.m−_2|



Table 1: Notation used in this document. 

In this section, we present the theory behind participating media volumetric lighting and shadowing. We will also present the different parameters as well as how they interact and influence the final result. The goal is to help you understand the behaviour of each of the different parameters. 

To go further, one can also visit the **ShaderToy** website to get access to volumetric scattering and shadowing example code (See Figure 4). Frostbite is using such code to simulate volumetric light interactions. Figure 4: Shader toy example presenting volumetric scattering and shadowing [Hilb][Hilc].[|] 8 

## **2.1 Single scattering** 

We will focus on the simulation and rendering of _single scattering_ in participating media. In case you are still hungry for more after this chapter, your could read the following very well written resources: [PH10], [dEo16] or [Wre11]. One of the best explanation of scattering event is accessible in chapter 4 of [Jar08]. 

Considering light traveling straight through a medium, different events can make the outgoing luminance be different as compared to the luminance that went in: 

- **absorption** _σa_ : photons are absorbed by the medium matter. 

- **out-scattering** _σs_ : photons are scattered away by bouncing off particle in the medium matter. This will be done according to the phase function _p_ describing the distribution of bounce direction (See Section 2.3). 

- **in-scattering** _σs_ : photons can scatter in the current light path after bouncing off particles and contribute to the final luminance. This will also be done according to the phase function _p_ . 

- **emission** : light can be emitted when media reach high heat, _e.g._ fire. We ignore this component in this document. 

To sum it up, adding photons on a path is a function of _σs_ and removing photon is a function of extinction _σt_ = _σa_ + _σs_ representing both absorption and out-scattering. 

Each of these events are wavelength dependent. It means that the way different light frequencies will be absorbed or scattered with different probabilities. For the sake of real-time efficiency, we will only simplify this by considering the red (680 _nm_ ), green (550 _nm_ ) and blue (440 _nm_ ) light spectrum. The final per spectrum luminance integration can be performed using equation 1 considering punctual lights. A sketch presenting the different components is visible in Figure 5. 

**==> picture [385 x 217] intentionally omitted <==**

**----- Start of picture text -----**<br>
𝑺<br>𝑽𝒊𝒔 𝒙𝒕, 𝑳× 𝑳(𝒙𝒕, ω𝒊)<br>𝒙<br>𝒊 ω<br>𝒊 𝒙<br>𝒔<br>𝒙𝒕-1 𝒙𝒕 𝒙𝒕+1<br>𝒑(𝜽)<br>**----- End of picture text -----**<br>


Figure 5: Sketch illustrating the integration of scattered light in a virtual world with a single point light using parameters and equations presented in this section. 

**==> picture [394 x 28] intentionally omitted <==**

9 

The **transmittance** _Tr_ ( _x, xt_ ) in Equation 2 is a function of extinction. The higher the extinction, or the distance, the higher the **optical depth** _τ_ = _σt_ ( _xt_ ) _dt_ will be and, in turn, the less light will travel through the medium section. The behaviour of the transmittance function is presented in Figure 6. Transmittance needs to be applied on (1) the luminance _L_ ( _xs, ωi_ ) from opaque surface, (2) the luminance _Lscat_ ( _xt, ωi_ ) resulting from an **in-scattering** event and also (3) each path from a scattering event to the light source. (1) will result in some visual fog-like occlusion of surface, (2) will result in self-occlusion of participating media and (3) will result in volumetric shadows within the participating media. Since _σt_ = _σa_ + _σs_ , it is expected that the transmittance is influenced by both the scattering, _i.e._ out-scattering, and absorption components. 

**==> picture [435 x 279] intentionally omitted <==**

**----- Start of picture text -----**<br>
xb<br>Tr ( xa, xb ) = exp( − σt ( x ) dt ) (2)<br>� x = xa<br>1.0<br>0.8<br>0.6<br>0.4<br>0.2<br>1 2 3 4 5<br>**----- End of picture text -----**<br>


Figure 6: Transmittance function as a function of depth and extinction _σt_ = 0 _._ 5, _σt_ = 1 _._ 0 and _σt_ = 2 _._ 0. 

A single **in-scattering** event is represented by _Lscat_ ( _x, ωi_ ) in Equation 3, describing the amount of luminance scattered back to a direction according to all the punctual light sources of a scene, the visibility function _V is_ ( _x, L_ ) as well as the phase function _p_ described in Section 2.3. 

**==> picture [350 x 34] intentionally omitted <==**

The **visibility** function _V is_ ( _x, L_ ) from Equation 4 represents the amount of light reaching the light source. For instance, if an opaque object is sitting in between a light source and the sample point _x_ , thus occluding the sample, the _shadowMap_ ( _x, L_ ) will simply return 0 instead of 1 (in the case of an infinitesimally small punctual light, ignoring soft shadow). This is traditionally achieved using hardware shadow mapping relying light view depth textures. 

The _volumetricShadow_ ( _x, L_ ) represents the transmittance from the sample point _x_ to the light position _xL_ with values in [0 _,_ 1] per wavelength, thus allowing the participating media to self-shadow. This is usually achieved using secondary ray marching toward each light source. As a quality performance trade-off, specific volumetric shadow sampling/storage techniques [Hil15][JB10][Sal+10] can be used to store transmittance for out-going direction from a light. 

10 

_V is_ ( _x, L_ ) = _shadowMap_ ( _x, L_ ) _∗ volumetricShadow_ ( _x, L_ ) _volumetricShadow_ ( _x, L_ ) = _Tr_ ( _x, xL_ ) 

(4) 

## **2.2 Albedo** 

The albedo Equation 5 is a value representing the relative importance of scattering relatively to absorption in a medium for each considered spectrum band. The value is within the [0 _,_ 1] range: 

- An albedo close to 0 indicates that most of the light is absorbed, resulting in a very dark medium ( _e.g._ dark exhaust smoke) 

- An albedo close to 1 indicates that most of the light is scattered instead of being absorbed, resulting in a brighter medium ( _e.g._ air, cloud or earth atmosphere) 

**==> picture [282 x 28] intentionally omitted <==**

## **2.3 Phase function** 

As mentioned before, a participating medium is composed particle with varying radius. The distribution of these particles radius will influence the distribution of light scattering direction at any point within participating media. Describing such probability distribution is achieved using a phase function used when evaluating in-scattering as shown in equation 3. 

**==> picture [264 x 23] intentionally omitted <==**

A phase function will change the in-scattering at a point _x_ as a function of the directional luminance information reaching that point. Different types of scattering can be identified from _x_ the **relative size** of a particle as defined by equation 6 where _r_ is the particle radius and _λ_ the considered wavelength [Hul57][Wikg]: 

- _x ≪_ 1 : For example Rayleigh scattering ( _e.g._ air) 

- _x ≈_ 1 : Mie scattering 

- _x ≫_ 1 : Geometric scattering 

More components can influence the scattering result such as the index of refraction or the participating media content, _etc_ . We will ignore them for this version of the document. 

## **2.3.1 Isotropic scattering phase** 

In this case, light will be scattered uniformly in all direction. Surely not a very realistic scenario but it is commonly used due to its simplicity. The phase function is presented in equation 7 where _θ_ is the angle between incoming light direction and out scattering direction. 

**==> picture [268 x 23] intentionally omitted <==**

11 

## **2.3.2 Rayleigh scattering phase** 

**==> picture [297 x 24] intentionally omitted <==**

Rayleigh derived expressions for the scattering of light off molecules in the air [Ray71]. For instance, Rayleigh scattering is used to describe light scattering happening in the earth atmosphere and is reported as having very low to no absorption. This phase is a two-lobe function as visible in Figure 7 and can be evaluated using equation 8. 

**==> picture [383 x 251] intentionally omitted <==**

**----- Start of picture text -----**<br>
0.10<br>0.05<br>- 0.15 - 0.10 - 0.05 0.05 0.10 0.15<br>- 0.05<br>- 0.10<br>**----- End of picture text -----**<br>


Figure 7: Polar plot of the Rayleigh phase function. 

Rayleigh scattering is also highly dependent on the wavelength of light. This is represented by a wavelength dependent scattering coefficient _σs_ equation presented in [Jar08]. An approximation commonly used is to set constant _σs_ for each of the reduced R, G and B light spectrum band commonly used when evaluating/rendering such scattering events. 

## **2.3.3 Mie scattering phase** 

Mie scattering [Mie08] is the model that can be used when the size of particles is similar to the light wavelength. However, Mie scattering is complex to simulate and requires many power functions. 

An alternative is to use the Henyey-Greenstein phase function 8 with g in ]0 _,_ 1[. It has been proposed to represent the scattering by interstellar dust. It can also be used to represent any smoke, fog or dust like participating media. Such media can exhibit a very strong backward or forward scattering resulting in large visual halos around light sources, _e.g._ spot lights in fog, or the strong silver lining effect at the edge of clouds in the sun direction. 

**==> picture [326 x 28] intentionally omitted <==**

This Henyey-Greenstein phase function can feature more complex shape than Rayleigh scattering and is evaluated using Equation 9. It can result in varied shape as shown in Figure 8. The strength of forward or backward scattering is controlled using the g parameter. 

12 

**==> picture [383 x 146] intentionally omitted <==**

**----- Start of picture text -----**<br>
0.15<br>0.10<br>0.05<br>0.2 0.4 0.6 0.8<br>- 0.05<br>- 0.10<br>- 0.15<br>**----- End of picture text -----**<br>


Figure 8: Polar plot of the Henyey-Greenstein and Schlick appoximation phase functions. 

A fast way to approximate the Henyey-Greenstein phase function is to use an approximation proposed by Schlick. This equation 10 does not feature any complex power function but instead only a square which is a lot faster to evaluate. To be able to map that function onto the original HenyeyGreenstein phase function, the _k_ parameter need to be computed using _g_ . This only has to be done once for participating media having a constant _g_ value. It is interesting to note that for very strongly positive and negative _g_ values, the error can become quite large (see Figure 9) and result in lower silver lining effect. 

**==> picture [384 x 34] intentionally omitted <==**

**----- Start of picture text -----**<br>
1.0<br>- 1.0 5 10 15 20 25<br>**----- End of picture text -----**<br>


Figure 9: Polar plot of the Henyey-Greenstein and Schlick appoximation phase functions showing lager error for large g values. 

**==> picture [303 x 46] intentionally omitted <==**

## **2.3.4 Geometric scattering phase** 

Geometric scattering happens for very large particles. In this case, light can refract and reflect within each particles. This can result in complex scattering phase function also depending on light polarisation. For instance, a real life example of that, is the visual rainbow effect. It is caused by internal reflection of light inside water particles in the air, dispersing the sun light into a visible spectrum on a small visual angle ( _≈_ 3 degrees) of the resulting backward scattering. 

Such complex phase function can be evaluated using MiePlot software [Lav15]. This software uses the Mie scattering theory, Debye series and ray tracing to evaluate phase functions. The resulting phase function can be visualised and output into a file for usage in your applications. As shown in Figure 10. 

## **2.4 Examples** 

This Section presents the different components of volumetric rendering and how they can influence the final visual look of a volume. If you are starting experimenting with these types of algorithm, that 

13 

Figure 10: Exemple of a complex phase function generated using MiePlot [Lav15]. 

**==> picture [318 x 12] intentionally omitted <==**

**----- Start of picture text -----**<br>
(a) (b) (c)<br>**----- End of picture text -----**<br>


Figure 11: Enabling different volumetric rendering components: (a) _σs_ = 1 scattering without volumetric shadow, (b) _σs_ = _{_ 0 _._ 5 _,_ 1 _._ 0 _,_ 2 _._ 0 _}_ RGB scattering with grey volumetric shadows achieved with _σt_ = _mean_ ( _σs_ ) and (c) with colored volumetric shadow achieved with _σt_ = _σs_ = _{_ 0 _._ 5 _,_ 1 _._ 0 _,_ 2 _._ 0 _}_ . In each examples, absorption has been set to 0 _σa_ = 0. (a) and (b) are not physically correct but used here to present component contributions. 

Section should hopefully give you a good intuition of the role and influence of the different parameters. If you think anything is missing, please do get in touch[2] and the section will be updated. 

Figure 11 presents different components being enabled separately. Image (a) shows a Stanford bunny shaped participating medium under a white light and white scattering _σs_ = 1. Image (b) shows the same medium but now with _σs_ = _{_ 0 _._ 5 _,_ 1 _._ 0 _,_ 2 _._ 0 _}_ . Since the blue color scatters more, the bunny has an overall blue color. The volumetric shadow is a grey shadow evaluated using equation 4. The grey scale shadow is achieved using _σt_ = 2 _._ 0. This is just to show the addition of volumetric shadow, even though this is physically incorrect. To be physically correct, volumetric shadow should be evaluated using _σt_ = _σs_ + _σa_ = _{_ 0 _._ 5 _,_ 1 _._ 0 _,_ 2 _._ 0 _}_ (given the fact that _σa_ = 0 in this case). The resulting visual is 

> 2sebastien.hillaire@frostbite.com 

14 

**==> picture [310 x 155] intentionally omitted <==**

**----- Start of picture text -----**<br>
0.20<br>0.15<br>0.10<br>0.05<br>0.00<br>0 2 4 6 8 10<br>(a) (b)<br>**----- End of picture text -----**<br>


Figure 12: (a) graph representing the amount of light scattered after traveling through a uniform medium, taking into account transmittance and assuming a niform phase function, over a distance represented by the x axis. (b) The corresponding color gradient visualization of the graph. 

presented in Figure 11 (c). At the interface between air and the medium, when light has not traveled a long path, blue light is scattered more resulting in a blue color. For long light path deep from the entry point, the blue light has been scattered more. As a result, only the other components remain: that is why the red color is then more visible in this material configuration. This behavior is in fact similar to the one of light traveling in the atmosphere. It only happens at a larger scale because the concentration of air molecule in the atmosphere is a lot lower (see Section 3). In order to illustrate that idea using the same coefficient, we give the one-dimensional scattering profile in Figure 12 as a graph for R, G and B wavelength and color gradient. 

Figure 13: Stanford bunny and dragon with increasing density (from left to right: 0.1, 1.0 and 10.0) where _σs_ = _{_ 0 _._ 5 _,_ 1 _._ 0 _,_ 2 _._ 0 _}_ . 

15 

Figure 13 presents Stanford bunny and dragon with the same participating media material ( _σs_ = 0 _._ 5 _,_ 1 _._ 0 _,_ 2 _._ 0) but varying densities. For low density media, scattering coefficient will give the dominant participating medium color. When the density is increased, the resulting behaviour will be more complex as described previously, _i.e._ due to absoprtion and out-scattering. In the very dense case for the rightmost picture, the objects starts to almost look like flesh/skin. This is because our skin also has similar overall characteristic: red light travel further within our flesh. Skin is also a more complex volumetric material with many layers and thus can be expensive to evaluate using ray marching. Instead it is usually approximated with _cheaper_ diffusion profiles ignoring any form of single scattering phase function or anisotropy [Jen+01b] [DL07]. 

Figure 14: Stanford bunny using a the Henyey-Greenstein phase function 9 with _g_ ranging from isotropic to strong forward scattering (from left to right _g_ = 0 _._ 0 _,_ 0 _._ 5 _,_ 0 _._ 9 _,_ 0 _._ 99 _,_ 0 _._ 999) and dnesity of 1.0 (top) and 10.0 (bottom). 

The phase function will also greatly influence final look of participating media. For instance, it is critical to achieve the characteristic look of clouds in order to get their characteristic sliver lining visual effect. And this is the same for many types of smoke for instance. This phenomenon is visible in Figure 14 especially for dense material blocking the light from traversing it (bottom row). You can also notice that for strong forward scattering, _g >_ 0, the medium will look brighter when looking towards the light source. Indeed, strong forward scattering media will scatter more and more light toward it traveling direction only, leaving other areas darker. This generates halos around light sources, generating the glow everyone knows, for instance when looking at street lights in foggy days. Then the thicker the medium gets, the less light will be able to travel through it. However, the strong forward scattered light will still be get through for small optical depth near the edge of the volume, resulting in the silver lining visual effects. 

## **2.5 Related chapters** 

The participating media material and light interaction described in this section is the foundation of all the techniques and result presented in this document. The concept presented here will be discussed the following Section: 

- Rayleigh and Mie scattering and the atmosphere medium: Section 3.2 

- Cloud phase function: Section 5.7 

- Integration improvement: Section 5.6 

- Multi-scattering approximation: Section 5.8 

16 

## **3 Sky and Atmosphere** 

This section describes how sky and atmosphere scattering can be simulated and rendered. There are already plenty of very detailed resources on that area. Thus this section will be short and we will reference outside articles and open source code as much as possible. 

The research and development presented in this section have been conducted as a joint effort together with: 

- Ghost: Gustav Bodare and Edvard Sandberg (2015 Frostbite/DICE/Chalmers Master students [BS]) 

- Ghost (Need for Speed[TM] ) 

- DICE (Mirror’s Edge Catalyst[TM] ) 

- Bioware (Mass Effect Andromeda[TM] ) 

## **3.1 Previous work** 

Rendering a world inherently requires the rendering of a planet sky and atmospheric effects. On Earth, what we call the blue sky is the result of the sun light scattering in the atmosphere participating media. The atmosphere is also a key visual cue: its color is linked to the current time of day, _i.e._ sun direction, and its foggy visual appearance helps with the perception of distance and relative size. As such, it is important to be able to accurately render these components required by an increasing amount of games needing dynamic time of day and large open world to explore, drive or even fly over. The first physically based atmosphere rendering model from Nishita _et al._ [Nis+93] was dedicated to the rendering of the earth from space. Since then, many sky rendering methods have been proposed to render atmosphere and skies fro, the ground up to space. They can be split in two categories: 

- Analytic models [PSS99][HW12][CIE95] 

- Iterative models [Ril+04][Wen07][ONe07][BN08][Ele09][HW12][Yus13a] 

Analytic models build a set of parameters used to evaluated the sky look. For instance [PSS99] relies on turbidity, a measure of the fraction of scattering due to haze as opposed to molecules (Mie/Rayleigh scattering), luminance at zenith and of course view and sun directions. These models however are limited to ground view or atmosphere parameters can’t be changed freely to simulate extra terrestrial planets, or reach specific art driven visuals. 

The spectral rendering of the sky can be used for an improved accuracy in many models but we cannot really afford that for real time games on today’s platforms. In this case we will restrict ourselves to the usual 3 wavelength of the visible light range: red ( _λ_ = 680 _nm_ ), green ( _λ_ = 550 _nm_ ) and blue ( _λ_ = 440 _nm_ ). 

**From now on, we are going to focus on iterative atmosphere models relying on LUTs for atmosphere simulation and rendering** . If you want more details about how these sky simulation models can be implemented, we strongly recommend you to read [BN08], [Ele09] and [Yus13a] in details. Their implementations are nicely described, detailed and **open source code** is also provided at the following addresses [Bru17] and [Yus13b] respectively. 

Iterative models mainly rely on ray marching in order to integrate scattered light. This result is usually stored in look-up tables (LUT) in order to avoid the expensive cost of ray marching. Those textures can then simply efficiently, leveraging hardware filtering features of graphic cards. For instance, Bruneton et al. [BN08] are generating the following LUTs: 

17 

- 2D Transmittance LUT: only indexed on view height and azimuth angles thanks to earth spherical symmetry. 

- 4D scattering LUT: since this depends on height, view and light direction, it is indexed based on a custom remapping of these values to also avoid certain visual artifact at the horizon. 

The 4D scattering LUT can then be used to iterate on multiple order of scattering and thus preintegrating a LUT already containing multi-scattering [BN08]. That is a very important property of these approach since multi-scattering is especially important when the sun is at the horizon in order to not get too saturated or dark. 

Elek _et al._ [Ele09] proposed to reduce the 4D scattering LUT dimensionality by ignoring the change of scattering as a fucntion of the horizontal/azimuthal angle betwen the view direction and the sun direction. This simplification basically remove the earth shadow from the atmosphere multi-scattering solution. This result in a simpler 3D LUT that is faster to evaluate in real-time on GPU. Additionaly, Yusov [Yus13a] proposed an improved parametrization helping getting more details at the horizon and reducing some visual artifacts that can appear at the horizon. 

## **3.2 Sky and atmosphere participating media definition** 

To be able to render sky and atmosphere, we need to take into account several components. We must first consider the atmosphere as a constant height slab around the earth with a exponential distribution of air molecules in it. 

Light interacting with air particles that are much smaller than the light’s wavelength results in the highly wavelength dependent **Rayleigh** scattering. Considering the earth atmosphere, blue light are scattered more and that is why the sky appears blue during the day. However when the sun is at the horizon, light will have to travel a longer distance in the atmosphere and most blue light will be scattered away. Blue light will not travel as far as the green and red light in the atmosphere. That is why sunset and sunrise appear reddish. 

Another important component of the atmosphere is the large particles concentrated near the ground. The concentration of these particles depends a lot on weather conditions, or pollution for instance. These particles cause wavelength independent **Mie** scattering. So the phase function describing how light will scatter is usually not uniform but biased toward the direction of the light travel direction, _i.e._ forward scattering. This phenomenon will cause the bright halo we usually see around the sun. 

## **3.3 Atmosphere composition** 

In this sub-section we describe what coefficients and distribution should be used. After discussing with [BN08], we have learned that these coefficients do not represent scattering coefficient gathered from all wavelengths and integrated with respect to the RGB visible spectrum according to the Human perception. Instead the scattering coefficients for R, G and B were only taken for the corresponding wavelengths 680, 550 and 440 nanometres. 

We follow the usual description of the atmosphere from [Ril+04] and [BN08]. On top of which we also add Ozone contribution which is important for the look of that sky a sunset and sunrise. Table 2 summarizes all the coefficients and their distribution in the atmosphere. 

We have chosen to use the same Rayleigh scattering coefficient as [Ril+04] and [BN08], even though the evaluation of Equation 11 gave us different numbers (5 _._ 47 _e[−]_[6] _,_ 1 _._ 28 _e[−]_[5] _,_ 3 _._ 12) _[−]_[5] for air refractive iindex _n_ = 1 _._ 0003, a number of molecule per meter cube _N_ = 2 _._ 545 _×_ 10[25] and a standard air depolarisation factor _pn_ = 0 _._ 035 [PSS99]. The Mie coefficient is really up to the atmosphere status: clarity, pollution, dust, sand storm, _etc_ . 

18 

**Type Scattering (** _m[−]_[1] **) Extinction (** _m[−]_[1] **) Distribution** _−h_ Rayleigh (molecule) _σs[Ray]_ = (5 _._ 8 _e[−]_[6] _,_ 1 _._ 35 _e[−]_[5] _,_ 3 _._ 31 _e[−]_[5] ) _σs[Ray] e_ 8 _._ 0 _km −h_ Mie (dust) _σs[Mie] >_ = 2 _e[−]_[6] 1 _._ 11 _σs[Mie] e_ 1 _._ 2 _km −h_ ~~esa~~ Ozone 0 _σa[O]_[3] _e_ 8 _._ 0 _km_ Table 2: Default earth atmosphere properties. _σs[Ray]_ =[8] _[π]_[2][(] _[n]_[2] _[ −]_[1][)][2] _×_[6 + 3] _[p][n]_ (11) 3 _Nλ_[2] 6 _−_ 7 _pn_ 

Figure 15: Left: light, earth-like and heavy Rayleigh scattering. Right: default earth-like sky with no, default and heavy Mie scattering. 

The result of using such coefficients is visible in Figure 15. You can notice that increasing the Rayleigh scattering will increase the blueness of the sky until light extinction become more important due to out-scattering, as shown in participating media example Section 2.4. Increasing Mie scattering 

19 

simply makes the atmosphere look more dusty as if there would heavy pollution or a sand storm. 

## **3.4 Ozone absorption** 

As reported by Adams [CK74], taking into account ozone particle absorption is _Essential [. . . ] to reproduce the blue of the zenith sky_ . Kutz in his master thesis blog present visual improvement resulting from taking into accoutn ozone [Kut13]. Unfortunately, the absorption coefficients are no shared: we present here how we recovered them. We recover _σa[O]_[3] using Equations 12 and 13. We first recover the air molecule per unit volume ( _molecule/m_[3] ) using Equation 12 where _airConcentration_ = 41 _._ 58 _mol/m_[3] [Wikk] is the air density at sea level and _NA_ = 6 _._ 022140857 _×_ 10[23] is the Avogadro constant [Wiki]. Then using Equation 13 the absorption coefficient is evaluated from ozone cross section and air density. The ozone cross section is taken from measured data from [Ser13]: the value is an average of each R, G and B wavelength range for all emasured temperatures. According to overall ozone percentage in the atmosphere air [Kut13], the final recovered values for ozone absorption are _σa[O]_[3] = (3 _._ 426 _,_ 8 _._ 298 _,_ 0 _._ 356) _×_ 0 _._ 06 _×_ 10 _[−]_[5] . Ozone should be concentrated 32km up in the sky. But this was giving us unexpected results (probably due to using RGB instead of a more complete spectrum). Instead, we have chosen ozone to follow the same atmosphere distribution as the Rayleigh scattering particle distribution and thus the absorption coefficients can simply be added to the Rayleigh extinction coefficient used for the scattering simulation. 

**==> picture [318 x 12] intentionally omitted <==**

**==> picture [397 x 158] intentionally omitted <==**

The result of using ozone is visible in Figure 16. Without ozone, the sky can appear too yellow overall. Taking into account ozone in the extinction coefficient (see Section 2.1) can bring back a more consistent blue sky color at sunset and sunrise. 

As a _side note_ , we have tried to use the wavelength dependent ozone absorption coefficients from [PSS99] and the spectrum to XYZ functions from [WSS13]. We have tried different transform and sRGB gamut space clipping without being able to recover a consistent absorption coefficients with respect to simulated distances. This approached proved to be unstable and we would be interested in any feedback and why/what we might have done wrong. The attempt to recover these coefficients is available publicly in a ShaderToy [Hila]. Figure 17 show the ShaderToy presenting multiple graphics: the wavelength to RGB weights, the ozone absorption curve in grey per wavelength range, as well as recovered RGB colour after distance based absorption per wavelength band and transformation back into RGB space. You can notice that negative absorption coefficients are sometimes recovered and that is completely invalid. That is why help and/or suggestions are welcome. 

20 

Figure 16: Left: default sky. Right: default sky with added ozone absorption. 

Figure 17: The spectrum to RGB ozone absorption ShaderToy [Hila]. 

## **3.5 Our approach** 

The physically based sky system available in Frostbite borrows from many research results: Bruneton [BN08], Elek [Ele09] and Yusiv [Yus13a]. Here is a list of choice: 

- We use a 3D look up table as in [Ele09] instead of the 4D original one [BN08]. This only means that we ignore the view/sun azimuth angle: for instance we cannot represent the shadow of the earth in the scattering look-up table. We found that this is a reasonable assumption for most use cases we encountered so far. A comprehensive list of all assumptions is available in Section 4.1.1 of [Ele09]. 

- As described by Bruneton _et al._ [BN08] the scattering LUT can have accuracy issue at the horizon, resulting is visual artefacts for elevation angle of 0 when the view is near the ground. We rely on the parameterisation improvement proposed by Yusov [Yus13c]. We give simple non-optimized reference hlsl code for the parametrization we use in appendix A. 

- Evaluating the scattered luminance using LUTs per pixel multiple times when rendering the aerial perspective on opaque surface could be expensive depending on your budget. To reduce the cost, we evaluate each frame the scattered luminance for current view in a low resolution 3D texture fitted on the camera frustum (default resolution: 32x32 with 16 depth slices). This makes the fog evaluation cheaper and has the advantage of being easy to evaluated and apply on all transparent meshes to ensure consistency. On Frostbite, we sample this volume texture on transparent per vertex. Aerial perspective rendering is visible in Figure 18. 

21 

- We give artists a way to also add height fog to their scenes [Wen07]. For the final image to looks consistent under time of day, we color the height fog according to a luminance taken from the LUT at the horizon. This is valid thanks to the use of a 3D scattering LUT instead of the 4D one mentioned above (it owuld have required to sample the value accros the full horiwon in this case). This lumminance is taken into account together with the phase functions evaluated per pixel when when applying the heigh fog on the scene [Hil15]. This results in seamless transition from height fog near the camera, at the horizon and transition to the sky as in Figure 18. 

- Once the LUTs have been computed, the sun can be moved freely. But changing some atmosphere parameters such as _height_ , _scattering_ or _extinction_ coefficients will trigger a LUT update that is too costly. We counter that issue by temporally amortize the look-up table update cost over multiple frames (see Section 3.5.1.) 

## **3.5.1 Performance** 

In order to result in coherent and unified lighting and shadowing, the physically-based sky must be rendered in multiple views, _e.g._ main, planar reflection, environment map. In this section we give our latest performance results on XBox One. 

|**Pass**|**Performance**|
|---|---|
|720p Main view<br>AP volume 32x32x16 (Section 3.5)<br>LUT update on one frame<br>LUT update 19 frames|0.42 ms<br>0.05 ms<br>3.50 ms<br>0.22 ms per frame|



Table 3: Physically based sky rendering performance on XBox One. 

The performance given in Figure 3 are given for a full screen sky. When atmosphere properties are changed, we must update the transmittance and scattering look-up tables. This could take as much as 3.5ms, due to the fact that multi-scattering is also integrated. To avoid this cost, we are distributing the evaluation of the LUT on multiple frames while lerping between the last two valid results [BS]. This is a key point which allowed us to make the technique affordable for 60 frame per second titles. It does add a little bit of latency but that has been deemed acceptable for all of our use cases.. 

## **3.5.2 Results** 

Results from the dynamic sky are visible in this entire document, this section and also the volumetric cloud Section 5. The first games to ship with that technology were Need for Speed 2016 [Gho15] and Mirror’s Edge catalyst [DIC16] [Chr16]. 

Since the sky simulation takes scattering and extinction coefficients as input, it is possible to render any extra-terrestrial planets. For instance, Mars is called the red planet because it appears as a red star due to its rusty ground. It also appears that Mars atmosphere would scattered more the red and green component of the light spectrum. This is why the mars atmosphere at day time appears yellow or orange [NAS16]. A direct consequence of that fact is that sunsets on Mars are not red but blue as shown by NASA on their website [NAS05] and as visible in Figure 19. We have not been able to find Mars atmosphere scattering properties but Figure 20 shows a series image from a time-lapse render of a sunset on Mars rendered with Frostbite and using an eye-balled set of atmosphere properties. 

22 

Figure 18: Sky, atmosphere scattering and height fog. From top to bottom; left: only sun light, added sky rendering, added aerial perspective; Right: progressively adding a thicker height fog. 

23 

Figure 19: Left: Mars view during day light [NAS16]. Right: Mars view during sunset [NAS05]. 

Figure 20: Time-lapse of a Mars atmosphere sunset simulation in Frostbite. 

24 

## **4 Sun, Moon and Stars** 

Rendering skies involves the rendering of many other far away elements: 

- Sun 

- Moon 

- Stars 

- Celestials 

When rendering these elements involves paying attention to many small details. One also needs to know their properties such as luminance or angular diameters [Wika] to faithfully represent them. 

## **4.1 Sun** 

The sun is the stars the earth is orbiting around. From the see level, Its angular diameter is between 32 _._ 7 to 31 _._ 6 minutes of arc depending on time of year [NAS16], i.e. according to its orbit position. It corresponds to an angular diameter of 0 _._ 527 deg to 0 _._ 545 deg. 

**==> picture [420 x 173] intentionally omitted <==**

**----- Start of picture text -----**<br>
Zenith<br>> Lsouterspace<br>ωs<br>Current sun position<br>T [zenith] ωs<br>vs<br>Lsouterspace<br>T [sun]<br>EsZenith<br>Essun<br>**----- End of picture text -----**<br>


Figure 21: Sketch presenting the different elements and quantities discussed in this Section: earth, atmosphere, transmittance, sun luminance and illuminance at zenith and current sun position. 

## **4.1.1 Sun illuminance** 

The sun illuminance _Es_ at ground level (Figure 21) is reported as being a value between 100000 to 120000 Lux [Wikf]. 

In Frostbite, artists author the sun contribution by giving its illuminance at zenith _Es[zenith]_ . This is more convenient for them as it becomes easier and more intuitive to compare results again real world values (see [LR14] Section 4.6). It is also given for the sun at zenith after the atmosphere transmittance has been applied to it. This is then easier for artists to abstract away earth transmittance resulting form non trivial distribution of particles in the atmosphere and scattering/absorption coefficients. 

25 

## **4.1.2 Sun luminance** 

In Frostbite, the light buffer stores luminance _L_ , not illuminance _E_ . As such, we need to convert the sun illuminance _Es[zenith]_ given by artist to its luminance _Ls_ that will be applied on the sun disk. In order to achieve this, the following process is applied: 

1. Considering the sun as a perfect disk, evaluate its solid angle _ωs_ (assumed constant on earth) 

2. Evaluate sun luminance _L[zenith] s_ at ground level according to _ωs_ and _Es[zenith]_ 

3. Considering the earth transmittance and sun at zenith, evaluate the sun outer space luminance _L[outerspace] s_ 

4. Render the sun using _L[outerspace] s_ and apply atmosphere transmittance to it 

For a cone with aperture _θ_ radians, the solid angle can be evaluated using Equation 14. It is thus possible to recover sun the solid angle _ωs_ (between 0 _._ 0000664 _sr_ and 0 _._ 0000711 _sr_ for physical angular diameters reported above). 

**==> picture [291 x 12] intentionally omitted <==**

In the case of the sun, illuminance at ground level is given by artist for a sun at zenith and independently of its subtended solid angle. If we consider the sun having a relatively small solid angle and of a relatively uniform luminance, we can approximate its illuminance _Es[zenith]_ as the integral over its solid angle using equation 15. Then we can simply recover the sun luminance _L[zenith] s_ using equation 16 

**==> picture [291 x 43] intentionally omitted <==**

**==> picture [285 x 27] intentionally omitted <==**

For a given earth/atmosphere setup, it is possible to easily compute transmittance at zenith _Tratmosphere[zenith]_[by][integrating][extinction][from][the][ground][along][the][up][vector][until][the][considered][atmo-] sphere upper boundary. Outer space luminance can now be computed as _L[outerspace] s_ = _L[zenith] s /Tratmosphere[zenith]_[.] the reasonable assumption we are making here is that atmosphere transmittance never reach 0 for each wavelength components. 

Having the sun outer space luminance, we can thus render the sun sprite as a perfect disk, matching its angular diameter, and add its luminance _L[outerspace] s_ contribution to the light buffer. However, if only this is done, the sun will simply look like a very bright disk because the atmosphere transmittance _Tratmosphere[sun]_[is][ignored.][This][can][be][resolved][by][using][the][atmosphere][transmittance][lookup][table] described in Section 3. Once sampled per pixel, we simply evaluate the sun correct final luminance as _Ls_ = _Tratmosphere[sun][×][ L] s[outerspace]_ . This final correct and matching result is visible in Figure 22. 

With this process done, the sun will have a correct appearance matching its zenith angle as well as the atmosphere properties. This is especially important when the sun moves to simulate time of day. It is also important on low exposure scene such as dusk or dawn setup for the sun to not bloom out the picture when visible. Also, since the sun luminance is recovered from its illuminance and solid angle, making the sun larger will automatically dim its luminance. This process automatically makes sure that the overall visual scene lighting remains consistent with the sun appearance. 

Example of values for the sun on earth: 

26 

Figure 22: Screenshots showing the sun disk at horizon (dusk setup) rendered without (left) and with (right) atmosphere transmittance applied per pixel. 

- Illuminance on ground _Es[zenith]_ = 120000 Lux 

- Angular diameter of 0 _._ 545 deg corresponds to a solid angle of 0 _._ 0000711 _sr_ 

- Luminance _L[zenith] s_ = 1 _._ 69 _×_ 10[9] _cd.m[−]_[2] 

**==> picture [486 x 390] intentionally omitted <==**

**----- Start of picture text -----**<br>
• Outer space luminance L [outerspace] s =  L [zenith] s /Tratmosphere [zenith]<br>Using Frostbite default physically based sky simulation from Section 3,, transmittance can get a<br>value between 0 . 925 ,  0 . 861 ,  0 . 755 at zenith and 0 . 0499 ,  0 . 004 ,  4 . 10 e [[−]] [[5]] when the sun is at the horizon.<br>Figure 23 present the different properties of the transmittance according to the sun elevation.<br>Transmitance<br>1.<br>0.8<br>0.6<br>0.4<br>0.2<br>0 Sun elevationangle<br>0 10 20 30 40 50 60 70 80 90<br>a<br>Figure 23: Top: transmittance curve for each RGB channel of perceptible light wavelength. Middle: transmittance as a<br>color for elevation of 90, 45, 20, 10, 5 0 degrees. Bottom: scaled transmittance according to highest wavelenght channel<br>to visualize transmittance tint, i.e. hue.<br>**----- End of picture text -----**<br>


Using Frostbite default physically based sky simulation from Section 3,, transmittance can get a value between 0 _._ 925 _,_ 0 _._ 861 _,_ 0 _._ 755 at zenith and 0 _._ 0499 _,_ 0 _._ 004 _,_ 4 _._ 10 _e[[−]]_[[5]] when the sun is at the horizon. Figure 23 present the different properties of the transmittance according to the sun elevation. 

27 

## **4.1.3 Limb darkening** 

The sun appears as a disk in the sky. But because the sun is a sphere, the disk will not have a uniform luminance [Wikh]. This is due to the fact that, for a given point of view, more light will be visible when viewing the surface along it normal (center of the disk) than tangent to it (edges of the disk). Indeed, in tangent areas, light has to travel more trough the sun gas and thus will also get more absorbed. This phenomenon results in a sun disk being visually more intense at its center than at its edge. Astrophysics researchers have measured the luminance variation of emitted light on the sun disk and proposed some models [Nec96]. 

Figure 24: Screenshots showing the sun disk at horizon (dusk setup) rendered (a) without limb darkening, (b) with limb darkening matching earth solar system sun [HM98] and (c) an even strong limb darkening effect obtained by changing the parameters. 

The implementation of [Nec96] and [HM98] models is given in this document. The HLSL source implementation is available in Appendix B. The gradient resulting from the model proposed in [Nec96] is visible in Figure 25. It is possible to initialise the model to the earth solar system sun and still give artists a way to author limb darkening. In a real-time context, you may even want to simplify and optimise these models to a simple gradient texture lookup. 

Figure 25: The sun limb darkening gradient resulting from [Nec96] with the sun disk center on the left and its outer edge on the right. 

## **4.2 Moon** 

The moon is a satellite orbiting the earth at a mean distance of 384000 _km_ . Its angular diameter is between 29 _._ 3 to 34 _._ 1 minutes of arc depending on time of year [Wikj]. This corresponds to an angular diameter between 0 _._ 488 deg to 0 _._ 568 deg. 

- Illuminance on ground _Emoon_ = 0 _._ 26 Lux [Wikf] 

- Angular diameter of 0 _._ 568 deg corresponds to a solid angle of 0 _._ 0000711 _sr_ 

- Luminance _Lmoon_ = 3658 _cd.m[−]_[2] 

Since _Emoon_ is illuminance at ground level (after atmosphere transmittance), _Lmoon_ could be used to render the moon luminance after multiplication by a texture presenting its albedo. 

One tricky effect to render is to make the moon and other orbiting objects have a lit and shadowed side with respect to single and/or multiple sun(s). This case is not handled today in Frostbite: artists are responsible for the setup. On top of that, as a fun fact, one must keep in mind the moon terminator illusion [VSc]. 

28 

## **4.3 Stars** 

Stars are light emitter bodies scattered in the universe. The most well known of them being the sun. We have not found any mean solid angle, illuminance or luminance data for stars. We have only been able to gather the following data: 

- Typical value for stars contribution to earth lighting have been reported in [Jen+01a] ( _Estarts_ = 3 _e[−]_[2] _W/m_[2] ) 

- The angular diameter of constelations, solar systems, a few stars and other object in space are reported in [Wika] 

A way to render stars is also presented in one of Neyret’s shader toy [Ney]. It is rendering coloured stars according to their temperature. The colour is recovered using Plank’s law describing spectral density of electromagnetic radiation for each temperature [Wikl][Wikb]. 

## **4.4 Results** 

Figure 26 presents the result when rendering sun, moon and stars sprites at dawn and night time in Frostbite. Environment map and local reflection volumes cube-map can capture the moon, stars and other space and celestial elements. This result in the moon and start being visible in reflections, increasing the realism and overall coherency of a scene. When these cube maps are convolved, these elements will be part of the convolution, also resulting in more consistent lighting. 

Figure 26: Screenshots showing the rendering of the sun disk (enlarged), moon and stars at (left) dawn time, (right) night time also their presence in reflections. 

29 

## **5 Clouds** 

The research and development presented in this section have been conducted as a joint effort with: 

- Rurik H¨ogfeldt (2015 Frostbite Master student [H¨og]) 

- Bioware: Marc-Andre Loyer (Programmer), Soren Hesse (Tech Environment Art) and Don Arceta (Lead Environment Art) 

## **5.1 Background and Previous work** 

Clouds are a very complex and a very expressive visual feature of skies. Art wise, one can make them look menacing, representing incoming storm, epic or discreet, thin or massive, _etc_ . Cloud usually move slowly but needs to be dynamic for large open world game with dynamic weather changes. Different techniques can be used to achieve these looks depending on the level of complexity of a game setup and budget. 

When considering the classic approach of rendering a sky and clouds using a single panoramic texture, Guerette proposed to use a well known visual flow technique in order, to give an illusion of motion in the sky [Gue14]. The cloud would them appear to move in a direction set for instance the global wind direction. This is a very effective method that however do not involved any variation of cloud shape, weather nor lighting. 

Figure 27: Results obtained by Yusov _et al._ [Yus14]. 

In the case of flight simulator, Harris posoposed to render clouds as volumes of particles [Har02]. The method was made very efficient by not rendering all particles all the time but impostors representing groups of particles when far away. This gives the possibility to update impostors at a lower rate according to the camera distance and relative displacement. Another particle based cloud rendering method is the one presented by Yusov [Yus14]. Strato-cumulus like clouds can be rendered by taking into account the dynamic lighting of the sun and sky using per particle pre-integrated lighting. The simplistic particle-like look was avoided by using depth aware blending made possible using a new hardware feature called _Rasterizer Ordered Views_ , see Figure 27. These two particles based approaches can be very efficient at rendering clouds but are mostly limited to cumulus-like shapes. 

30 

## Figure 28: Results obtained by Bouthors _et al._ [Bou+08]. 

A few volumetric based cloud rendering techniques have also been researched [Ril+04][Bou+08][Sch15]. For instance, Bouthors render clouds with a mix of meshes and ray mached _hyper_ textures [Bou+08]. The final scattering light is gather using disk-like shaped light collectors positioned at the surfaces of the cloud shape. The light transfert is integrated while ray-marching in real-time and accelerated using off-line pre-computed transfer tables. The final result is of very high visual quality as visible in Figure 28 but it also has a non-negligible GPU cost. Furthermore, the combined mesh and hyper texture data are not straightforward for artists to comprehend, create and edit. 

Figure 29: Results obtained by Schneider _et al._ [Sch15]. 

31 

In the context of real-time game, Reset is the first game that has demonstrated advanced cloud rendering together with atmosphere interaction [Ltd]. However, not a lot have been disclosed publicly about the algorithm detail. Schneider presented a visually similar ray-marched approach [Sch15], allowing to render dynamically lit volumetric clouds. With few parameters, the method allows the rendering of complex cloud shapes with many details as seen in Figure 29. The use of volumetric textures containing _Perlin-Worley_ noise has been suggested as a very good fit to better represents the cauliflower-like shape of cumulus-like clouds. The resulting clouds are completely dynamic and can evolve according to time and weather constrains. This technique is very applicable to real-time games thanks to the use of temporal integration of the scattered light solution allowing to to temporally integrate the final scattering result. 

For Frostbite we decided to follow the path of [Ltd] and [Sch15] since they have the following advantage we needed: 

- Realistic cloud shapes 

- Large scale clouds possible 

- Dynamic, so weather change can be happen 

- Dynamic volumetric lighting and shadowing support 

We want our implementation to fit into the Frostbite physically based framework: have material information decoupled from lighting and be energy conserving. This to ensure coulds would fit within any lighting environment which is a must have when dealing with dynamic time of day and weather. 

## **5.2 Cloud participating media material** 

Clouds are made of very thick participating media. Hess _et la._ [HKS98] measured water clouds and reported a single scattering albedo _ρ_ = 1 and high extinction _σt_ coefficient in the [0 _._ 04 _,_ 0 _._ 06] range for stratus, [0 _._ 05 _,_ 0 _._ 12] for cumulus (for the 550um wavelength corresponding to perceptible green). Given the fact that _ρ_ is very close to 1, _σs_ = _σt_ can be assumed. 

Cloud single scattering is a very important part of their defining look together with their very specific phase function discussed in Section 5.7. With only single scattering, and due to their thickness, clouds would only look like dirty/smoky element with only scattered light at their surface. To avoid this, Another defining component of clouds look must be taken into account: the many scattering events taking place within them. Details on how to approximated this characteristic is given in Section 5.7. 

## **5.3 Cloud authoring** 

The way artist can author clouds and their distribution in the world is very similar to the one in [Sch15] with some extra control that were needed for our games and uses cases. This volumetric approach used to generate cloud shapes is called procedural, it uses algorithms to generate content from a few parameters. Using algorithm to generate artistic data can be hard to control and also not always compatible with artists visions. that is why defining a set of meaningful input parameters for artists to achieve their vision is important. This section explains the controls exposed to artists authoring volumetric clouds in Frostbite. 

Being a procedural approach, one can easily think of **tens to thousands** of ways to produce parameters and controls that will blend together using formulas to produce volumetric clouds. We present here our approach that matches our games and our artists desires. It is up to you to find what suits your need and you games best. 

32 

## **5.3.1 Cloud distribution and density** 

The clouds are assumed to remain within a single slab of constant height around the earth. They are made of a single participating media material with varying density only. Artists create a _weather texture_ having a world space size and extent over the world. That texture is scaled and repeated all over the world if necessary. And example is visible in Figure 30 each channel represents: 

- Red channel: 2d projected cloud density. 

- Green channel: 2d projected cloud type index. 

Figure 30: Example of cloud weather texture. Artists can paint the world space distribution of clouds as well as their type. 

The cloud type is used to index another _cloud type_ texture along the x axis in texture space. The Y texture space axis is the normalised height within the cloud layer. And example such as texture is visible on in Figure 31 each channel represents: 

- Red channel: the density of the cloud within the layer height. 

- Green channel: the erosion amount applied (small scale noise eroding large scale noise). This directly maps to the amount of turbulence of the cloud surface. 0 maps to smooth, 1 maps to fully eroded by the 3D erosion texture according to parameters similar to [Sch15]. 

The cloud type texture allows artist to specify cloud profile along the atmosphere height. Using such a texture also allows artists lots of freedom. They can for instance represent multiple layers of clouds or Anvil clouds (see Section 5.11). We simply ask artists to keep these textures as small as possible to help reduce texture cache miss as much as possible. Both textures can be statically assigned to a level and also dynamically updated if necessary. 

While ray-marching the cloud layer, we evaluate the cloud density according to the weather texture, type texture but also according to two different volume noise textures in a similar fachion to [Sch15]. A low frequency _noiseL_ is first used to give a base shape to clouds and break down the repeatability 

33 

Figure 31: Example of cloud type texture. Artist can paint it in order to control the height based density as well as erosion. 

of the weather texture, also called _base shape_ . A high frequency one _noiseH_ is then use to erode that base shape and add details at edges. We present a way to generate these volume noise textures in the next Section 5.4. 

## **5.4 Cloud noise** 

The cloud rendering algorithm described in [Sch16] propose to use a specific setup of tile-able volume noise textures but no source code or texture is given. We describe the texture generation in this section and link to an open source repository where source code can be accessed. 

The _noiseL_ volume texture is generated as a combination of Perlin-Worley noise and multiple octaves of Perlin noise. The _noiseH_ texture is generated as multiple octaves of Worley noise. Worley noise is very interesting when it comes to cloud rendering since it helps representing the cauliflower like shape they can take at times. 

This textures can be presented as 4-component RGBA textures that are combined using in shader math [Sch16]. In Frostbite we simply use a single component volume texture representing the final single channel noise. This made cloud a lot faster to render thanks to the reduction of required memory bandwidth still giving the same final visual result. 

Figure 32: These image show 4 slices of tile-able volume noise: Top, _shape_ noise containing cauliflower like Perlin-Worley noise shape, bottom: _erosion_ noise made of multiple octaves of Perlin noise. 

We give away a small program to generate such noise using open source libraries. Please refer to Appendix D for description and more details on how to access the code. 

34 

## **5.4.1 Cloud material** 

The cloud participating media material is described as a single participating media material. It consists of the following parameters: 

- Absorption _σa_ described in Section 2 

- Scattering _σs_ described in Section 2 

- Dual lobe phase function described in Section 5.7 

Only the density of the material is spatially varying. This density is built using the procedural approach described in the previous sub-section. In order for cloud to look convincing, the choice of noise is however crucial. 

## **5.5 Cloud rendering** 

Using the material and equations described in Section 2 we integrate different lighting components presented in Figure 33. 

Figure 33: The different lighting components taken into account when ray marching the cloud layer (from top-left to bottom-right): (1) background transmittance, (2) ambient scattering, (3) not shadowed sun light scattering, cloud self shadowed sun light scattering without (4) and with (5) forward scattering phase function. 21 samples were used to generate these images. 

## **5.5.1 Ambient lighting** 

Cloud ambient lighting is sampled using a global light probe represented as Spherical Harmonics [LR14]. For the sake of performance, ambient lighting occlusion is not taken into account when evaluating ambient lighting. This is would have not been practical given our current game budget and pre-integrating occlusion would also be tricky due to the very procedural nature of the volumetric cloud involving complex noise shapes and erosion processes. We only take into account the first non directional term of Frostbite global probe. Thus, luminance resulting for ambient lighting contribution can often be too bright. To counter this effect, we give artist a way to scale down the ambient component according to scale in [0 _,_ 1]. Taking into account the sky, i.e. atmosphere scattering, can result in slightly blue cloud if no multi-scattering solution is used. To resolve that issue, we also give artists a way to desaturate the luminance resulting from ambient lighting. 

We also weight ambient lighting using a linear gradient in [0 _,_ 1] from the bottom to the top of the cloud layer. This approach assumes that the sky is the only contribution to the ambient lighting 

35 

and that it ignores bounce lighting from the earth. This can be approximated with two different approaches: 

- Bias the gradient range to [ _a,_ 1] in order to take into account that _a_ % of the ambient lighting is due to bounce of the earth ground. 

- Sample the ambient contribution from the global probe coming from the top and bottom of the hemisphere. This is an improved version of the above one if the global probe is taking into account some overall tint when integrating the luminance coming from the bottom hemisphere / earth. 

The ambient contribution control presented in this sub-section are not physically based but allowed our game teams to reach their visual target. 

## **5.5.2 Sun shadow sampling** 

In order to generate volumetric shadow, we ray-march toward the sun for each samples taken along the view vector. Ray-marching is done in a straight line toward the sun according to the current sample jittered position (See next Section focusing on _temporal scattering integration_ ). Shadow samples are taken four times according to a base shadow sample distance that is multiplied by a constant factor for each sample. This in order to progressively sample further away from the source sample. This progressive shadow sample scheme together with the temporal jittering result in smooth/soft shadow estimation. 

## **5.5.3 Temporal scattering integration** 

We render the clouds in a single pass. Each frame, samples are randomly offset within their sampling step/depth range. Once the current frame solution has been estimated, it is blended with the previous frame solution according to a constant blend factor. This result in a temporal integration of the scattering solution achieved using an exponential moving average. For the final frame to not look blurry when the camera is moving moving/rotating very fast, we re-project the previous result according to previous and current camera properties, _i.e._ projection and transform. 

Figure 34: Left: 14 cloud samples without temporal integration. Right: same view and sample count with temporal scattering integration. 

This techniques allows us to us a lot less samples per frame while maintaining visual quality. The difference and improvement is visible in Figure 34. 

36 

## **5.6 Improved scattering** 

When integrating scattered lighting in participating media in real-time, one has to use as few samples as possible to be efficient. One issue that arise in this case is that a single sample will then represents an integration over a larger distance. The larger the distance, the less representative this sample will be, decreasing the accuracy of the integration. We describe here different integration approaches and also propose a new one which give higher quality and is also energy conserving. 

## **5.6.1 Usual scattering integration** 

The usual and simple way to integrated scattered and transmittance along a ray is presented in Listing 5.6.1. The scattered lighting is initalised to (0 _,_ 0 _,_ 0) and transmittance to 1. Each step a material sample and a light sample are taken as used to update scattered light and transmittance according to Equation 1. 

1 2 `// Contains integrated scattered luminance (in rgb) and trasmittance (in a) along a ray.` 3 `float4 intScattTrans = float4 (0.0 , 0.0, 0.0, 1.0);` 4 `for ( uint samplerIt = 0; samplerIt < smapleCount ; ++ samplerIt)` 5 `{` 6 `float4 scatteringExtinction = takeMediaSample (coord);` 7 `const float3 scattering = scatteringExtinction .rgb;` 8 `const float transmittance = exp (- scatteringExtinction .a * ds);` 9 10 `// Get sun luminance according to volumetric shadow and phase function` 11 `const float3 luminance = sunLuminance (coord , sunDir , viewDir);` 12 13 `intScattTrans .rgb += scattering * luminance * intScattTrans .a * ds; // (S) step` 14 `intScattTrans .a *= transmittance ; // (T) step` 15 `}` 

Listing 1: Simplified code presenting a way to integrate scattered light and transmittance along a ray. 

There is one problem with that formulation: inScattTrans.rgb is updated using inScattTrans.a **(S)** and then inScattTrans.a is updated **(T)** . But is the correct order of this steps? In fact, as presented in Figure 35, none is correct. If **(S)** is executed before **(T)** , then scattering will be added without taking into account transmittance over the sampling range _ds_ , resulting in non-energy-conserving integration. If **(T)** is executed before **(S)** , then the resulting participating media will look too bright as the scattered lighting will be over occluded using the entired _ds_ range. 

Figure 35: Issues when integrating scattered light with left: **(S)** is executed before **(T)** (not energy conserving), middle: **(T)** is executed before **(S)** (too much absorption of energy), right: a reference integration with many step showing the expect result. 

Overall, for non dense material, the error presented in Figure 35 will remain very small. A very simple integration such as the one presented here would work for light fog for instance. However, it will start to break for very dense material, when _σs_ becomes high. 

37 

## **5.6.2 Better numerical integrations** 

To better approximate the definite integral of a curve using a low number of samples, it is possible to use different numerical approaches such as the trapezoidal method [Wikn] or the Simpson’s rule [Wikm]. We will take the example of the trapezoidal rule in this section. 

**==> picture [452 x 126] intentionally omitted <==**

**----- Start of picture text -----**<br>
t0<br>1.0<br>0.8<br>t1<br>0.6<br>t2 0.4<br>t3 0.2<br>t4<br>0<br>d0 d1 d2 d3 d4 0.2 0.4 0.6 0.8 1.0<br>**----- End of picture text -----**<br>


Figure 36: Left: different integration solution, Right: difference between linear and _exp_ ( _−x_ ) function. 

Trapezoide rule describe how a curve integral can be approximated using a few samples and the trapezoidal surface area equation. On the left image of Figure 36, Let’s consider the transmittance as the green curve and a scattered light luminance of 1. The transmittance as evaluated by code presented in Listing 5.6.1 with **(T)** executed before **(S)** ( _e.g._[�] ( _tx/_ ( _dx_ +1 _− dx_ ))) will result in too much absorption: the red squares Y-axis top-cap will always always under the green curve we want to integrate. However, executing **(S)** before **(T)** ( _e.g._[�] ( _tx_ +1 _/_ ( _dx_ +1 _− dx_ ))) will result in a nonenergy-conserving integral since the Y-axis top-cap of the red squares will always be above the green curve. 

Using the trapezoide curve will allow to integrate between each interval [ _dx, dx_ +1] using a piece-wise linear top cap [Wikn]. The trapezoidal integration represent the integration of the orange curve in Figure 36. You can see that the orange curve is a closer match to the green reference curve we want to integrate. However, we can still notice that the integration will not be energy conserving: as visible on the right image of Figure 36, the orange curve is still always above the green reference curve. As a result participating media material will still scatter more light than they should, and the discrepancy will be higher for high value of _σs_ , _i.e._ the green curve would converge quicker towards 0 in this example but not the orange curve. 

## **5.6.3 Energy-conserving analytical integration** 

To solve this issue, we propose to analytically integrate the scattered light over a range according to both extinction _σt_ and a scattered light sample _S_ = _Lscat_ ( _xt, ωi_ ) as well as an integration depth _d_ . If we consider taking a single sample for the scattered light sample, we would only have to integrate it for each point on the piece of curve according to transmittance to the front depth of the range. This is achieved using Equation 17 [Hil15]. 

**==> picture [329 x 28] intentionally omitted <==**

Using Equation 17 is staightforward: one only need to take a single _σt_ and _S_ per slab. The integrated scattered light can be evaluated using the given aforementioned equation while applying and updating the transmittance of previous integration as shown in Listing 5.6.3. This will result in energy conserving scattering over the considered depth range _d_ . You might have noticed that the 

38 

result of Equation 17 is undefined when extinction _σt_ = 0. We simply resolve that issue by clamping extinction to a small epsilon. 

1 2 `// Contains integrated scattered luminance (in rgb) and trasmittance (in a) along a ray.` 3 `float4 intScattTrans = float4 (0.0 , 0.0, 0.0, 1.0);` 4 `for ( uint samplerIt = 0; samplerIt < smapleCount ; ++ samplerIt)` 5 `{` 6 `float4 scatteringExtinction = takeMediaSample (coord);` 7 `const float3 scattering = scatteringExtinction .rgb;` 8 `const float extinction = scatteringExtinction .a;` 9 `const float clampedExtinction = max (extinction , 0.0000001) ;` 10 `const float transmittance = exp (- scatteringExtinction .a * ds);` 11 12 `// Get sun luminance according to volumetric shadow and phase function` 13 `const float3 luminance = sunLuminance (coord , sunDir , viewDir);` 14 `const float3 integScatt = (luminance - luminance * transmittance ) / clampedExtinction ;` 15 16 `intScattTrans .rgb += intScattTrans .a * integScatt ;` 17 `intScattTrans .a *= transmittance ;` 18 `}` 

Listing 2: Improved analytical scattering integration pseudo code. 

Using this integration improvement, it is possible to get participating media to look correct without too many samples when increasing the material density. Figure 37-left show that using the sampling presented in Section 5.6.1, 512 samples needs to be taken for the result to converge towards a correct result mathing the material (as compared to the wrong 21 samples pictures presented in Figure 35). However, on the right, when the scattering integration equation is used, only 21 samples are enough to reach the expected result. As you would expect, the image using 512 samples will result in a more accurate representation of the cloud shape but at least now the lighting result a more independent of the number of sampler. 

This analytical integration is simply more correct that the trapezoidal integration in this particular case. This is especially important when for physically based HDR lighting and rendering when contrast and luminance difference can be very large within a scene. For more details about this improved scattering integration formula, please refer to Appendix C. 

Figure 37: Left: Rendering clouds without Equation 17: 512 samples are needed to converge, and Right: with Equation 17 improved integration showing only 21 samples are needed to converge to an correct/acceptable visual result. 

## **5.7 Cloud phase function** 

In Section 2.3, we have described the phase function as a mathematical tool representing the bouncing light direction distribution when scattered. This is an important properties of participating media as 

39 

it defines some very important visual features: from forward scattering resulting in strong silver lining on cloud to subtle wavelength dependent geometric scattering resulting in colored fogbow. 

Figure 38: Example of cloud phase function generated with MiePlot [Lav15] (also discussed in [Bou+08]. This shows the scattering for a single light wavelength with all polarised light averaged on a logarithmic scale. 

As presented in [Bou+08], the cloud phase function can be very complex. Clouds, being composed of relatively large water droplet, can feature geometric scattering (see Section 2.3). An example such a cloud phase function is visible in Figure 38. You can notice the strong forward scattering spike on the right or also the complex fogbow visual effect at around 120 deg [Wikc]. Other cloud visual features are pseudo specular and glory halo [Wikd]. 

Figure 39: Cloud rendering with sun behind the camera with Left: single-lob _phg_ and right: dual lobe _pdual_ phase function. The top image show corresponding 2d phase function shapes assuming forward is toward the right. 

In a real-time context such as video games, we do not have the luxury of evaluating such complex phase function shape. Thus a single phase function is usually evaluated, ( _e.g._ a Henyey-Greenstein phase function). But when representing material featuring strong forward scattering such as cloud, the back scattering component can them become missing and cloud view from an opposite direction from the sun direction can look dull and lack details as visible in Figure 39 left image. Indeed, with a strong forward peak, only ambient lighting would remain when looking at clouds when the sun is behind the camera. To resolve this issue, we use a dual-lob phase function _pdual_ consisting of two 

40 

Henyey-Greenstein phase functions blended together according to a weight _w ∈_ [0 _,_ 1] as shown in Equation 18. 

**==> picture [359 x 12] intentionally omitted <==**

Using a dual lobe phase function gives artists a lot more control over the way light will bounce in the cloud participating media. It is now possible to better balance forward and backward scattering. Figure 39, right image, shows that a lot more details can be achieved by using a dual lobe phase function allowing both a strong forward scattering peak while also maintaining some amount of backward scattering to bring our more details from the clouds shape. 

## **5.8 Multiple scattering** 

Clouds scatter lights many and a huge part of their bright and white look is the result of multiscattering. Without multi-scattering cloud would mostly be lit sun and ambient at their edges, and would be very dark anywhere else. Multi-scattering is also a key component for clouds to not look like smoke. With the massive amount of water suspended in the air, puffy clouds can look very white and bright, even when lit by the very strongly blue tinted environment sky light scattering. As reported at he begining of this Section, cloud albedo is very clost to 1. 

Different methods can be used to evaluate multi-scattering solutions: 

- Path tracing (recursing): it would largely be out of budget for real time game use cases. 

- Pre-computed: this is similar to the collector based approach proposed by [Bou+08]. However it would likely be hard to pre-compute for procedural content. 

- Iterative: Similar to [Ele+14] One could propagate multi-scattered light in volume. Although automatic, we would however likely still end up out-of-budget with this technique due to the amount of memory required. 

In the end we settled to use the very simple multi-scattering approximation proposed by Wrenninge _et al._ [WKL13]. The method basically integrate multiple _octave_ of scattering and sum them. So basically, the final integrated scattering is: 

**==> picture [334 x 35] intentionally omitted <==**

Where the following substitutions are made: 

**==> picture [282 x 46] intentionally omitted <==**

In order to make sure this technique energy conserving when evaluating _Lmultiscat_ ( _x, ωi_ ), one must ensure that _a <_ = _b_ . Otherwise more light can be scattered than expected because equation _σt_ = _σa_ + _σs_ would not be respected any more since _σs_ could end up being larger than _σt_ . 

The advantage of this solution is that one can integrate the scattered light for each of the different octaves _while_ raymarching, all at once. The drawback is that it does not represent well complex multi-scattering behavior: for instance side or backward scattering, no cone spread, _etc_ . Despite these drawbacks, the technique works very well in practice and gives artists a fine grained control of the look of volumetric clouds. It is now possible for them to generate highly scattering, _i.e._ thick, participating media while still making sure the scattered light can punch through the medium in order to reveal inner details on the shadowed sides 40. 

41 

Figure 40: Exemple of cumulus (left) and cumulonimbus (right) clouds rendered with single scattering N=1 (top) and multi scattering with N=2 (middle) and N=3 with exaggerated multi scattering (bottom) 

## **5.9 Other interactions** 

Frostbite volumetric cloud shadow is built in completely part of the engine. It is expected that cloud will then interacts consistently with every elements of a scene. That in order to get everything to look consistent, whatever the planet, the time of day and the weather are. 

Clouds are taken into account when evaluating shadows or atmosphere scattering which enable many global effects to happen: 

- Shadow: volumetric cloud shadows are baked into a 2D texture storing transmittance and projected onto the world. It is applied on all opaque, transparent surfaces, and also sampled by our emitter system to correctly lit particles. The projection is very simple and assumes a overall flat planet around the camera, which is reasonable to assume for typical planets. 

- GI: the volumetric cloud shadow map is also sampled when updating input to our dynamic global illumination system (achieved using Enlighten [Geo17]). This results in dynamic global illumination being influenced by the cloud, weather and sun direction. 

- Clouds affecting aerial perspective: described in Subsection 5.9.2. 

- Aerial perspective affecting clouds: described in Subsection 5.9.1. 

42 

Figure 41: Important clouds and aerial perspective interactions. Left: heavy cloud layer simply composited over a bright day sky, Middle: aerial perspective applied on clouds, and Right: the correct result with clouds layer coverage affecting the aerial perspective. 

## **5.9.1 Aerial perspective affecting clouds** 

Clouds are usually very high in the atmosphere and far away from the camera. As a result their looks is affected by the aerial perspective, _i.e._ atmospheric light scattering happens in between cloud particle and the view point. Figure 41-left shows that if clouds are rendered without taking into account the aerial perspective, a visual discrepancy happens at the horizon between clouds and earth. The middle image shows the same scene but with aerial perspective applied to the cloud. The issue at the horizon is no longer visible. 

**==> picture [339 x 31] intentionally omitted <==**

On straightforward way to apply the aerial perspective on the cloud is to sample it while integrating the scattered light and transmittance during the cloud layer ray-marching. However, all those extra texture samples would make cloud passes more expensive. Instead we propose to achieve that goal in two steps: 

- Compute the cloud mean front depth weighted by the transmittance to the view point using Equation 21). This allows to evaluate a smooth front depth while taking into account the visibility of each sample and ignoring the depth of occluded samples. We simply skip samples if no cloud particle have been hit, _e.g._ when transmittance is 1. This result in a smooth depth buffer as visible in Figure 42. 

- Evaluate the aerial perspective scattering/transmittance texture only once and apply it onto the final integrated cloud scattered luminance and transmittance. 

## **5.9.2 Clouds affecting aerial perspective** 

Clouds covering the sky will influence the aerial perspective look due to their coverage and the light they scatter around. Under the cloud layer: 

- a thick cloud layer will block sky light from scattering in the atmosphere. 

43 

Figure 42: Weighted mean of cloud samples depth. This depth is used to sample the aerial perspective scattering and transmittance applied on clouds as a post-process. 

Figure 43: Sketch illustrating integration of cloud scattered luminance and transmittance. 

- a bright cloud resulting from high albedo will propagate more light in the atmosphere. The participating media and density coefficients will influence the amount and color of the scattered light. 

**==> picture [315 x 12] intentionally omitted <==**

As presented in [Hil16], see Figure 43, we sample the cloud _mean transmittance Trcloud_ and _integrate scattered luminance Lcloud_ over the hemisphere from the camera point of view at the ground level. This is achieved by simply rendering the clouds over a black background and storing per pixel scattered luminance and transmittance. 

This result is then used to affect the aerial perspective texture presented in Section 3.5 using equation 22. We simply attenuates aerial perspective scattered sun luminance according to the cloud layer mean transmittance, while adding cloud integrated scattered luminance contribution instead. 

44 

The improvement is visible in Figure 41 where the middle image have the aerial perspective unaffected by the cloud layer and the right image has it affected. You can notice how a lot less scattering is present in the atmosphere and that a dark blue scattered color form the dark opaque cloud layer is also visible. 

## **5.10 Performance** 

In order to achieve coherent visuals, unified lighting and shadowing, clouds must be rendered in multiple views: main, planar reflection, environment map or shadow. In this section we give our latest performance result on XBox One. 

|**View**|**Performance**|
|---|---|
|720p Main<br>720p planar reflection<br>1080p Main<br>1080p planar reflection|0.91 ms<br>0.14 ms<br>1.60 ms<br>0.20 ms|



Table 4: Cloud rendering performance on XBox One. 

The performance given in Figure 4 are given for the worst case when looking at the horizon, 3 _/_ 5 of the screen covered by clouds and 16 samples per pass. Main cloud view is rendered at half resolution and planar reflection a fourth of the the resolution. This performance is also given for multi scattering enabled with N=2 (see Section 5.8). 

## **5.11 Results** 

Figure 44: Illustration by Valentin de Bruyn [Wike]. Licence: Creative Commons Attribution-Share Alike 3.0. 

Additionally to the results shown in previous sections, we present here some extra visuals obtained after attempting to match different cloud types. Indeed, as visible in Figure 44 clouds can really get 

45 

a wide variety of shape, density, height, _etc_ . Thanks a lot to Soren Hesse for sharing some of his work here. 

Figure 45: Altostratus clouds. 

Figure 46: Cumulus clouds. 

46 

Figure 47: Some menacing large and thick cumulus clouds announcing heavy rain at dusk. 

Figure 48: Many stratocumulus at dusk. 

47 

Figure 49: Large and very dense cumulonimbus cloud. 

Figure 50: Far away massive and tall cumulonimbus anvil cloud coming our direction. Storm incoming! 

48 

Need for Speed Payback [Gho17] will be the first Electronic Arts game shipping with the volumetric cloud rendering technology. Results are visible in Figure 51. 

Figure 51: Need for Speed Payback official screen shots featuring Frostbite physically based volumetric clouds. 

49 

## **6 Conclusion** 

We have presented techniques to render a physically based sky, atmosphere, celestials and clouds. We have detailed the particular implementation in Frostbite used by many EA games in production. The techniques presented in this document have also been used in many recent Electronic-Arts games visible in Figure 52. The cloud rendering technique is the only one that has not be shipped yet but is already used in production for Need for Speed Payback [Gho17] and Anthem games [Bio17]. 

Figure 52: Recent Electronic Arts / Frostbite games has shipped using the techniques presented in this document. TopLeft to Bottom-Right: Need for Speed Payback [Gho17], Mirror’s Edge Catalyst [DIC16], Mass Effect Andromeda [BIO17] and FIFA 17 [Art16] 

The main challenge encountered during the development of all these games was to maintain a high visual quality under strong constraints. Those constraints drove many of the technical choices we had to do and presented in this document. Firstly performance: Mirror’s Edge and FIFA both are games running at 60 frames per seconds, so a minimal GPU cost is necessary. Secondly the interaction between many systems: changing cloud parameters which in turn influence atmosphere scattering, global illumination, _etc_ was also challenging from an implementation and visual coherence point of view. Finally all these systems had to be design for real-time preview by artists with minimal updates latency to maintain visual coherence while conditions, _e.g._ time of day or weather, evolve in real-time. 

**We hope this document will be helpful: (1) that new comers have found the participating media section to be complete and detailed enough to understand all the basic concept behind volumetric rendering, whether you are an artist or programmer, and (2) that the remaining parts of this document will help you implement and/or improve your sky, cloud and celestial rendering systems. If you would like to get more details about some of the discussions, equations or techniques presented, or if you have found any issue or a typo: please do not hesitate to reach out: sebastien.hillaire@frostbite.com or https://twitter.com/SebHillaire** . 

50 

## **6.1 Future work** 

We give here ideas and areas of investigations that could be researched to improve the techniques presented in this documents: 

- Aerial perspective sun volumetric shadow from clouds. Solutions have been proposed in previous papers [BN08][Yus13a] but they were aimed at volumetric shadow from opaque geometry only. We need a solution that would also take into account opqaue as well as participating media, e.g. clouds or local fog volumes [Hil15]. Maybe using a camera wrapped froxel volume or a special shadow projection mapped on the frustum. 

- Clouds are rendered in a layer behind everything. If one would want clouds to intersects with opaque geometry such a big mountain, it would need to only ray-march up to closest depth. Since clouds are rendered at lower resolution, extra compositing steps would be required: downsampled depth and bilateral upsampling from low resolution to full resolution. 

- Cloud ambient is a single color as of today without directionality nor occlusion. One could improve the quality by using Frostbite spherical harmonic probe main incoming light incoming direction, or a single ambient occlusion could be temporally integrated according to different direction each frame in the cloud volume. One could also taking into account the bounce color from the terrain. 

- Implement Bruneton’s model (4D multi-scattering LUT) or find a cheap way to approximate the earth shadowing of the atmosphere would be interesting to have a an option. In some cases, we have find that having such an visual option would be interesting. 

51 

## **References** 

|[Art16]|E. Arts. _FIFA 2017_. 2016. url: `https://www.easports.com/fifa`.|
|---|---|
|[BIO17]|BIOWARE. _Mass Efect Andromeda_. 2017. url: `https://www.masseffect.com/`.|
|[Bio17]|Bioware. _Anthem_. 2017. url: `https://www.ea.com/games/anthem`.|
|[BN08]|E. Bruneton and F. Neyret. “Precomputed Atmospheric Scattering”. In: _Proceedings of_|
||_the Nineteenth Eurographics Conference on Rendering_. EGSR ’08. Sarajevo, Bosnia and|
||Herzegovina: Eurographics Association, 2008, pp. 1079–1086. doi: `10.1111/j.1467-`|
||`8659.2008.01245.x`. url: `http://dx.doi.org/10.1111/j.1467-8659.2008.01245.x`.|
|[Bou+08]|A. Bouthors, F. Neyret, N. Max, E. Bruneton, and C. Crassin. “Interactive Multiple|
||Anisotropic Scattering in Clouds”. In: _Proceedings of the 2008 Symposium on Interactive_|
||_3D Graphics and Games_. I3D ’08. Redwood City, California: ACM, 2008, pp. 173–182.|
||isbn: 978-1-59593-983-8. doi: `10.1145/1342250.1342277`. url: `http://doi.acm.org/`|
||`10.1145/1342250.1342277`.|
|[Bru17]|E. Bruneton. _Precomputed Atmospheric Scattering_. 2017. url: `https://github.com/`|
||`ebruneton/precomputed_atmospheric_scattering`.|
|[BS]|G. Bodare and E. Sandberg. _Efcient and Dynamic Atmospheric Scattering_. url: `http:`|
||`//publications.lib.chalmers.se/records/fulltext/203057/203057.pdf`.|
|[Chr16]|F. Christin. “Lighting the City of Glass”. In: Game Developers Conference. 2016. url:|
||`http://www.gdcvault.com/play/1023284/Lighting-the-City-of-Glass`.|
|[CIE95]|CIE. “Spatial distribution of daylight-luminance distributions of various reference skies”.|
||In:_Color Research and Application_ 20.1 (1995), pp. 80–81.issn: 1520-6378.doi:`10.1002/`|
||`col.5080200119`. url: `http://dx.doi.org/10.1002/col.5080200119`.|
|[CK74]|G. P. Charles Adams and G. Kattawar. “The infuence of Ozone and Aerosol on the|
||Brightness and Color of the twilight Sky”. In: _Journal of the Atmospheric Sciences_ 31|
||(1974), pp. 1662–1674. url: `http://journals.ametsoc.org/doi/pdf/10.1175/1520-`|
||`0469(1974)031%3C1662:TIOOAA%3E2.0.CO%3B2`.|
|[dEo16]|E. d’Eon. _A HitchHicker’s Guide to Multiple Scattering_. 2016. url: `http://www.eugene`|
||`deon.com/project/a-hitchhikers-guide-to-multiple-scattering/`.|
|[DIC13]|DICE. _Battlefeld4_. 2013. url: `https://www.battlefield.com/games/battlefield-4`.|
|[DIC15]|DICE. _Star Wars Battlefront_. 2015. url: `http://starwars.ea.com/starwars/battlef`|
||`ront`.|
|[DIC16]|DICE. _Mirror’s Edge catalyst_. 2016. url: `http://www.mirrorsedge.com/`.|
|[DL07]|E. D’Eon and D. Luebke. _Advanced techniques for realistic real-time skin rendering_. Ad-|
||dison Wesley, 2007. url: `http://http.developer.nvidia.com/GPUGems3/gpugems3_`|
||`part03.html`.|
|[Ele+14]|O. Elek, T. Ritschel, C. Dachsbacher, and H.-P. Seidel. “Principal-Ordinates Propagation|
||for Real-Time Rendering of Participating Media”. In: _Computers & Graphics_ 45 (2014).|
||doi: `10.1016/j.cag.2014.08.003`.|
|[Ele09]|O. Elek. “Rendering Parametrizable Planetary Atmospheres with Multiple Scattering in|
||Real-time”. In: _CESCG_ (2009). url: `http://www.cescg.org/CESCG-2009/papers/`|
||`PragueCUNI-Elek-Oskar09.pdf`.|
|[Geo17]|Geomerics. _Enlighten_. 2017. url: `http://www.geomerics.com/enlighten/`.|
|[Gho15]|Ghost. _Need for Speed_. 2015. url: `https://www.needforspeed.com`.|



52 

|[Gho17]|Ghost. _Need for Speed Payback_. 2017. url: `https://www.ea.com/games/need-for-`|
|---|---|
||`speed/need-for-speed-payback`.|
|[Gue14]|K. Guerrette. “Moving the heavens”. In: Game Developers Conference. 2014. url: `http:`|
||`//www.gdcvault.com/play/1020146/Moving-the-Heavens-An-Artistic`.|
|[Har02]|M. J. Harris. “Real-Time Cloud Rendering for Games”. In: Game Developers Conference.|
||2002. url: `http://www.markmark.net/PDFs/RTCloudsForGames_HarrisGDC2002.pdf`.|
|[Hila]|S. Hillaire. _O3 Spectrum to RGB absorption_. url: `https://www.shadertoy.com/view/`|
||`ldySWV`.|
|[Hilb]|S. Hillaire._Volumetric Stanford Bunny_.url:`https://www.shadertoy.com/view/MdlyDs`.|
|[Hilc]|S. Hillaire. _VolumetricIntegration_. url: `https://www.shadertoy.com/view/XlBSRz`.|
|[Hil15]|S. Hillaire. “Physically Based and Unifed Volumetric Rendering in Frostbite”. In: _Ad-_|
||_vances in Real Time Rendering, Part I, ACM SIGGRAPH 2015 Courses_. SIGGRAPH|
||’15. Los Angeles, California: ACM, 2015.isbn: 978-1-4503-3634-5.doi:`10.1145/2776880.`|
||`2787701`. url: `http://advances.realtimerendering.com/s2015/`.|
|[Hil16]|S. Hillaire. “Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite”. In:|
||_SIGGRAPH 2016 Course: Physically Based Shading in Theory and Practice, ACM SIG-_|
||_GRAPH 2016 Courses_. SIGGRAPH ’16. Los Angeles, California: ACM, 2016.url:`http:`|
||`//blog.selfshadow.com/publications/s2016-shading-course/`.|
|[HKS98]|M. Hess, P. Koepke, and I. Schult. “Optical Properties of Aerosols and Clouds: The Soft-|
||ware Package OPAC”. In: _Bulletin of the American Meteorological Society_ 79.5 (1998),|
||pp. 831–844. doi: `10.1175/1520- 0477(1998)079<0831:OPOAAC> 2.0.CO;2`. eprint:|
||`http://dx.doi.org/10.1175/1520-0477(1998)079<0831:OPOAAC>2.0.CO;2`. url:|
||`http://dx.doi.org/10.1175/1520-0477(1998)079%3C0831:OPOAAC%3E2.0.CO;2`.|
|[HM98]|D. Hestrofer and C. Magna. “Wavelength dependency of the Solar limb darkening”. In:|
||_Astronomy Astrophysics_ 333.1 (1998), pp. 338–342.url:`https://www.researchgate.ne`|
||`t/publication/234185016_Wavelength_dependency_of_the_Solar_limb_darkening`.|
|[H¨og]|R. H¨ogfeldt. _Convincing Cloud Rendering: An Implementation of Real-Time Dynamic_|
||_Volumetric Clouds in Frostbite_.url:`http://publications.lib.chalmers.se/records/`|
||`fulltext/241770/241770.pdf`.|
|[Hul57]|H. C. V. de Hulst. _Light Scattering by Small Particles_. Reprint, edition (December 1,|
||1981). Dover Publications, 1957. isbn: 978-0486642284.|
|[HW12]|L. Hosek and A. Wilkie. “An Analytic Model for Full Spectral Sky-dome Radiance”. In:|
||_ACM Trans. Graph._31.4 (July 2012), 95:1–95:9.issn: 0730-0301.doi:`10.1145/2185520.`|
||`2185591`. url: `http://doi.acm.org/10.1145/2185520.2185591`.|
|[Jar08]|W. Jarosz. “Efcient Monte Carlo Methods for Light Transport in Scattering Media”. PhD|
||thesis. UC San Diego, Sept. 2008. url: `https://www.cs.dartmouth.edu/~wjarosz/`|
||`publications/dissertation/`.|
|[JB10]|J. Jansen and L. Bavoil. “Fourier Opacity Mapping”. In: _Proceedings of the 2010 ACM_|
||_SIGGRAPH Symposium on Interactive 3D Graphics and Games_. I3D ’10. Washington,|
||D.C.: ACM, 2010, pp. 165–172.isbn: 978-1-60558-939-8.doi:`10.1145/1730804.1730831`.|
||url: `http://doi.acm.org/10.1145/1730804.1730831`.|



53 

- [Jen+01a] H. W. Jensen, F. Durand, J. Dorsey, M. M. Stark, P. Shirley, and S. Premoˇze. “A Physically-based Night Sky Model”. In: _Proceedings of the 28th Annual Conference on Computer Graphics and Interactive Techniques_ . SIGGRAPH ’01. New York, NY, USA: ACM, 2001, pp. 399–408. isbn: 1-58113-374-X. doi: `10.1145/383259.383306` . url: `http: //doi.acm.org/10.1145/383259.383306` . 

- [Jen+01b] H. W. Jensen, S. R. Marschner, M. Levoy, and P. Hanrahan. “A Practical Model for Subsurface Light Transport”. In: _Proceedings of the 28th Annual Conference on Computer Graphics and Interactive Techniques_ . SIGGRAPH ’01. New York, NY, USA: ACM, 2001, pp. 511–518. isbn: 1-58113-374-X. doi: `10.1145/383259.383319` . url: `http://graphic s.ucsd.edu/~henrik/papers/bssrdf/` . 

||pp. 511–518. isbn: 1-58113-374-X. doi: `10.1145/383259.383319`. url: `http://graphic`<br>`s.ucsd.edu/~henrik/papers/bssrdf/`.|
|---|---|
|[Kut13]|P. Kutz._The Importance of Ozone_. 2013.url:`http://skyrenderer.blogspot.se/2013/`|
||`05/the-importance-of-ozone.html`.|
|[Lav15]|P. Laven. _MiePlot_. 2015. url: `http://www.philiplaven.com/mieplot.htm`.|
|[LR14]|S. Lagarde and C. de Rousiers. “Moving Frostbite to PBR”. In: _Physically Based Shading_|
||_in Theory and Practice, ACM SIGGRAPH 2014 Courses_. SIGGRAPH ’14. Vancouver,|
||Canada: ACM, 2014, 23:1–23:8.isbn: 978-1-4503-2962-0.doi:`10.1145/2614028.2615431`.|
||url: `http://www.frostbite.com/2014/11/moving-frostbite-to-pbr/`.|
|[Ltd]|T. I. Ltd. _Reset blog_. url: `http://reset-game.net/?p=284`.|
|[MH16]|S. McAuley and S. Hill. “Physically Based Shading in Theory and Practice”. In: _ACM_|
||_SIGGRAPH 2016 Courses_. SIGGRAPH ’16. Anaheim, California: ACM, 2016. isbn: 978-|
||1-4503-4289-6. doi: `10.1145/2897826.2927353`. url: `http://doi.acm.org/10.1145/`|
||`2897826.2927353`.|
|[Mie08]|G. Mie. “Beitr¨age zur optik tr¨uber medien, speziell kolloidaler metall¨osungen”. In:_Annalen_|
||_der Physik_. 1908, pp. 377–445.url:`http://www.dca.iag.usp.br/www/material/akemi/`|
||`radiacao-I/Mie_Horvath%20(2009).pdf`.|
|[NAS05]|NASA. _Sunset on Mars_. 2005. url: `http://www.nasa.gov/multimedia/imagegallery/`|
||`image_feature_347.html`.|
|[NAS16]|NASA. _Rover Opportunity Wrapping up Study of Martian Valley_. 2016. url: `https://`|
||`www.nasa.gov/feature/jpl/rover-opportunity-wrapping-up-study-of-martian-`|
||`valley`.|
|[Nec96]|H. Neckel. “On the wavelength dependency of solar limb darkening (_λλ_303 to 1099 nm)”.|
||In: _Solar Physics_ 167.1 (1996), pp. 9–23. issn: 1573-093X. doi: `10.1007/BF00146325`.|
||url: `http://dx.doi.org/10.1007/BF00146325`.|
|[Ney]|F. Neyret._Realistic display of star in Hubble images_.url:`https://www.shadertoy.com/`|
||`view/XdsGWs`.|
|[Nis+93]|T. Nishita, T. Sirai, K. Tadamura, and E. Nakamae. “Display of the Earth Taking into|
||Account Atmospheric Scattering”. In:_Proceedings of the 20th Annual Conference on Com-_|
||_puter Graphics and Interactive Techniques_. SIGGRAPH ’93. Anaheim, CA: ACM, 1993,|
||pp. 175–182. isbn: 0-89791-601-8. doi: `10.1145/166117.166140`. url: `http://doi.acm.`|
||`org/10.1145/166117.166140`.|
|[ONe07]|S. O’Neil. _Accurate Atmospheric Scattering_. Addison Wesley, 2007. url: `http://http.`|
||`developer.nvidia.com/GPUGems2/gpugems2_chapter16.html`.|
|[PH10]|M. Pharr and G. Humphreys. _Physically Based Rendering, Second Edition: From Theory_|
||_To Implementation_. 2nd. San Francisco, CA, USA: Morgan Kaufmann Publishers Inc.,|
||2010. isbn: 0123750792, 9780123750792. url: `http://www.pbrt.org/`.|



54 

|[PSS99]|A. J. Preetham, P. Shirley, and B. Smits. “A Practical Analytic Model for Daylight”. In:|
|---|---|
||_Proceedings of the 26th Annual Conference on Computer Graphics and Interactive Tech-_|
||_niques_. SIGGRAPH ’99. New York, NY, USA: ACM Press/Addison-Wesley Publishing|
||Co., 1999, pp. 91–100. isbn: 0-201-48560-5. doi: `10.1145/311535.311545`. url: `http:`|
||`//dx.doi.org/10.1145/311535.311545`.|
|[Ray71]|J. W. S. L. Rayleigh. “On the scattering of light by small particles”. In: _Philosophical_|
||_Magazine_ (1871), pp. 447–454.url: `http://journals.ametsoc.org/doi/pdf/10.1175/`|
||`1520-0469(1974)031%3C1662:TIOOAA%3E2.0.CO%3B2`.|
|[Ric]|C. Riccio. _GLM_. url: `http://glm.g-truc.net/`.|
|[Ril+04]|K. Riley, D. S. Ebert, M. Kraus, J. Tessendorf, and C. Hansen. “Efcient Rendering of|
||Atmospheric Phenomena”. In: _Proceedings of the Fifteenth Eurographics Conference on_|
||_Rendering Techniques_. EGSR’04. Norrkoping, Sweden: Eurographics Association, 2004,|
||pp. 375–386. isbn: 3-905673-12-6. doi: `10.2312/EGWR/EGSR04/375- 386`. url: `http:`|
||`//dx.doi.org/10.2312/EGWR/EGSR04/375-386`.|
|[Sal+10]|M. Salvi, K. Vidimˇce, A. Lauritzen, and A. Lefohn. “Adaptive Volumetric Shadow Maps”.|
||In:_Proceedings of the 21st Eurographics Conference on Rendering_. EGSR’10. Saarbr&#252;cken,|
||Germany: Eurographics Association, 2010, pp. 1289–1296. doi: `10.1111/j.1467-8659.`|
||`2010.01724.x`. url: `http://dx.doi.org/10.1111/j.1467-8659.2010.01724.x`.|
|[Sch15]|A. Schneider. “The Real-time Volumetric Cloudscapes of Horizon: Zero Dawn”. In: _Ad-_|
||_vances in Real Time Rendering, Part I, ACM SIGGRAPH 2015 Courses_. SIGGRAPH ’15.|
||Los Angeles, California: ACM, 2015. isbn: 978-1-4503-3634-5. doi: `10.1145/2776880.`|
||`2787701`. url: `http://doi.acm.org/10.1145/2776880.2787701`.|
|[Sch16]|A. Schneider. _Real-Time Volumetric Cloudscape_. Ed. by W. Engel. CRC Press, 2016,|
||pp. 97–127.|
|[Ser13]|A. Serdyuchenko. _O3 spectra_. 2013. url: `http://www.iup.physik.uni-bremen.de/`|
||`gruppen/molspec/databases/referencespectra/o3spectra2011/index.html`.|
|[VSc]|VScauce. _The Moon Terminator Illusion_. url: `https://www.youtube.com/watch?v=`|
||`Y2gTSjoEExc`.|
|[Wen07]|C. Wenzel. “Real time atmospheric efects in game revisited”. In: Game Developers Con-|
||ference. 2007. url: `http://developer.download.nvidia.com/presentations/2007/`|
||`D3DTutorial_Crytek.pdf`.|
|[Wika]|Wikipedia. _Angular diameter_. url: `https://en.wikipedia.org/wiki/Angular_diamet`|
||`er`.|
|[Wikb]|Wikipedia. _Black body radiation_. url: `https://en.wikipedia.org/wiki/Black-body_`|
||`radiation`.|
|[Wikc]|Wikipedia. _Cloud fog bow_. url: `https://en.wikipedia.org/wiki/Fog_bow`.|
|[Wikd]|Wikipedia. _Cloud glory halo_. url: `https://en.wikipedia.org/wiki/Glory_(optical_`|
||`phenomenon)`.|
|[Wike]|Wikipedia. _Cloud Types_. url: `https://en.wikipedia.org/wiki/Cloud`.|
|[Wikf]|Wikipedia. _Day light_. url: `https://en.wikipedia.org/wiki/Daylight`.|
|[Wikg]|Wikipedia._Light Scattering by Particles_.url:`https://en.wikipedia.org/wiki/Light_`|
||`scattering_by_particles`.|
|[Wikh]|Wikipedia. _Limb Darkening_. url: `https://en.wikipedia.org/wiki/Limb_darkening`.|



55 

|[Wiki]|Wikipedia. _Mole unit_. url: `https://en.wikipedia.org/wiki/Mole_(unit)`.|
|---|---|
|[Wikj]|Wikipedia. _Moon_. url: `https://en.wikipedia.org/wiki/Moon`.|
|[Wikk]|Wikipedia. _Number density_. url: `https://en.wikipedia.org/wiki/Number_density`.|
|[Wikl]|Wikipedia. _Planck s law_. url: `goo.gl/PqSGLi`.|
|[Wikm]|Wikipedia. _Simpson s rule_. url: `https://en.wikipedia.org/wiki/Simpsons_rule`.|
|[Wikn]|Wikipedia._Trapezoidal rule_.url:`https://en.wikipedia.org/wiki/Trapezoidal_rule`.|
|[WKL13]|M. Wrenninge, C. Kulla, and V. Lundqvist. “Oz: The Great and Volumetric”. In: _ACM_|
||_SIGGRAPH 2013 Talks_. SIGGRAPH ’13. Anaheim, California: ACM, 2013, 46:1–46:1.|
||isbn: 978-1-4503-2344-4. doi: `10.1145/2504459.2504518`. url: `http://doi.acm.org/`|
||`10.1145/2504459.2504518`.|
|[Wre11]|M. Wrenninge. “Production Volume Rendering”. In: _ACM SIGGRAPH 2011 Courses_.|
||SIGGRAPH ’11. ACM, 2011.|
|[WSS13]|C. Wyman, P.-P. Sloan, and P. Shirley. “Simple Analytic Approximations to the CIE|
||XYZ Color Matching Functions”. In: _Journal of Computer Graphics Techniques (JCGT)_|
||(2013). url: `http://jcgt.org/published/0002/02/01/paper.pdf`.|
|[Yus13a]|E. Yusov. “Outdoor Light Scattering”. In: Game Developers Conference. 2013. url: `htt`|
||`ps://software.intel.com/en-us/blogs/2013/06/26/outdoor-light-scattering-`|
||`sample`.|
|[Yus13b]|E. Yusov. _Outdoor Light Scattering Sample_. 2013. url: `https://software.intel.com/`|
||`en-us/blogs/2013/06/26/outdoor-light-scattering-sample`.|
|[Yus13c]|E. Yusov._Outdoor Light Scattering Sample Update_. 2013.url:`https://software.intel.`|
||`com/sites/default/files/blog/473591/outdoor-light-scattering-update_1.pdf`.|
|[Yus14]|E. Yusov. “High-Performance Rendering of Realistic Cumulus Clouds Using Pre-computed|
||Lighting”. In: _Eurographics/ ACM SIGGRAPH Symposium on High Performance Graph-_|
||_ics_. Ed. by I. Wald and J. Ragan-Kelley. The Eurographics Association, 2014. isbn: 978-|
||3-905674-60-6. doi: `10.2312/hpg.20141101`.|



56 

## **A Sky look-up table parametrization** 

In the appendix, we give functions we used to convert input parameters to LUT coordinates, and viceversa. These listings represent a version that can be used as reference path (not optimized). Listing 3 gives information about the contextual data, parametrization and LUT coordinate structure we use in Frostbite. Listing 4 gives the function transforming parameters into the look-up table coordinates. Listing 5 gives the inverse functions, transforming look-up table coordinates into parameters. 

1 2 `struct SkyLutContext` 3 `{` 4 `// Earth properties` 5 `float atmosphereRadius ;` 6 `float earthRadius ;` 7 8 `// Look up table resolution` 9 `float resolutionHeight ;` 10 `float resolutionView ;` 11 `float resolutionSun ;` 12 `};` 13 14 `struct SkyLutCoord` 15 `{` 16 `// Transmitance is only 2d texture` 17 `float2 transCoord;` 18 19 `// Scattering is a 3d texture.` 20 `float3 scattCoord;` 21 `};` 22 23 `struct SkyLutParameter` 24 `{` 25 `float height; // camera height between ground level 0 and atsmosphere height` 26 `float cosViewAngle ; // cos of view zenith angle` 27 `float cosSunAngle ; // cos of sun zenith angle` 28 `};` 29 30 `//` 31 `// [1] Yusov , Outdoor Light Scattering Sample Update` 32 `// [2] Elek , Rendering Parametrizable Planetary Atmospheres with Multiple Scattering` 33 `// [3] Bruneton , Precomputed Atmospheric Scattering` 34 `//` 

Listing 3: Unoptimized reference code for physically based sky look-up table mapping. 

57 

1 2 `SkyLutCoord convertSkyParamsToLutCoords ( in SkyLutContext context , in SkyLutParameter params)` 3 `{` 4 `SkyLutCoord output;` 5 6 `// Normalised coordinates based on camera height between ground level 0 and atsmosphere height` 7 `// Used in [1][2][3] , Eq. 4 in [1]` 8 `float normalisedheight = clamp (params.height , 0.f, (context. atmosphereRadius - context. earthRadius));` 9 `normalisedheight = saturate ( normalisedheight / (context. atmosphereRadius - context. earthRadius));` 10 `normalisedheight = pow (normalisedheight , 0.5f);` 11 12 `// Normalised coordinates based on angle between zenith direction and view direction` 13 `// Eq 6 in [1]. Used for view direction but here used for sun direction.` 14 `float normalisedViewZenithTrans = 0.5*( atan ( max (params.cosViewAngle , -0.45f)* tan (1.26f *0.75f)) / 0.75f + (1.0 - 0.26f));` 15 16 `// Normalised coordinates based on andgle between zenith direction and view direction` 17 `// Eq. 7 in [1]` 18 `float height = max (params.height , 0.f);` 19 `float cosHorizon = - sqrt (height *(2.f*context. earthRadius + height)) / (context. earthRadius + height);` 20 `float normalisedViewZenithScatt ;` 21 `if (params. cosViewAngle > cosHorizon )` 22 `{` 23 `float cosViewAngle = max (params.cosViewAngle , cosHorizon + 0.0001f);` 24 `normalisedViewZenithScatt = saturate (( cosViewAngle - cosHorizon ) / (1.f - cosHorizon ));` 25 `normalisedViewZenithScatt = pow ( normalisedViewZenithScatt , 0.2f);` 26 `normalisedViewZenithScatt = 0.5f + 0.5f / float (context. resolutionView ) + normalisedViewZenithScatt * ( float (context. resolutionView ) / 2.f - 1.f) / float ( context. resolutionView );` 27 `}` 28 `else` 29 `{` 30 `float cosViewAngle = min (params.cosViewAngle , cosHorizon - 0.0001f);` 31 `normalisedViewZenithScatt = saturate (( cosHorizon - cosViewAngle ) / ( cosHorizon - (-1.f)));` 32 `normalisedViewZenithScatt = pow ( normalisedViewZenithScatt , 0.2f);` 33 `normalisedViewZenithScatt = 0.5f / float (context. resolutionView ) + normalisedViewZenithScatt * ( float (context. resolutionView ) / 2.f - 1.f) / float ( context. resolutionView );` 34 `}` 35 36 `// Sun an texcoord` 37 `// Eq 6 in paper [1]` 38 `float normalisedSunZenith = 0.5*( atan ( max (params.cosSunAngle , -0.45f)* tan (1.26f*0.75f)) / 0.75f + (1.0 - 0.26f));` 39 40 `// Map normalised coordinates into in -between pixel range according to resolution` 41 `output.transCoord = float2 (normalisedheight , normalisedViewZenithTrans );` 42 `output.transCoord = (( output.transCoord * ( float2 (context.resolutionHeight , context. resolutionView ) - 1) + 0.5) / float2 (context.resolutionHeight , context. resolutionView ));` 43 44 `// Map normalised coordinates into in -between pixel range according to resolution` 45 `output.scattCoord = float3 (normalisedheight , normalisedViewZenithScatt , normalisedSunZenith );` 46 `output.scattCoord.xz = (( output. scattCoord * ( float3 (context.resolutionHeight , context. resolutionView , context. resolutionSun ) - 1) + 0.5)` 47 `/ float3 (context.resolutionHeight , context.resolutionView , context. resolutionSun )). xz;` 48 49 `return output;` 50 `}` 

Listing 4: Unoptimized reference code for physically based sky look-up table mapping. 

58 

1 2 `// Transmittance look up is only a float3 so SkyLutParameter . cosSunAngle will be 0.` 3 `SkyLutParameter convertTransmittanceLutCoordsToSkyParams ( in SkyLutContext context , in float2 coords)` 4 `{` 5 `// Invert valid pixel range mapping` 6 `float2 texCoords = saturate (( coords * float2 (context.resolutionHeight , context. resolutionView ) - 0.5) / ( float2 (context.resolutionHeight , context. resolutionView ) - 1));` 7 8 `// Invert height mapping` 9 `texCoords.x *= texCoords.x; // squared` 10 `float height = texCoords.x * (context. atmosphereRadius - context. earthRadius );` 11 12 `// Invert view mapping` 13 `float cosViewAngle = tan ((2.0* texCoords.y - 1.0 + 0.26) *0.75) / tan (1.26*0.75) ;` 14 `cosViewAngle = clamp (cosViewAngle , -1, 1);` 15 16 `// Output` 17 `SkyLutParameter output = ( SkyLutParameter )0;` 18 `output.height = height;` 19 `output. cosViewAngle = cosViewAngle ;` 20 `return output;` 21 `}` 22 23 `SkyLutParameter convertScatteringLutCoordsToSkyParams ( in SkyLutContext context , in float3 coords)` 24 `{` 25 `// Invert valid pixel range mapping` 26 `float3 texCoords = saturate (( coords * float3 (context.resolutionHeight , context. resolutionView , context. resolutionSun ) - 0.5) / ( float3 (context.resolutionHeight , context.resolutionView , context. resolutionSun ) - 1));` 27 28 `// Invert height mapping` 29 `texCoords.x *= texCoords.x; // squared` 30 `float height = texCoords.x * (context. atmosphereRadius - context. earthRadius );` 31 32 `// Invert view mapping` 33 `height = max (height , 0.0);` 34 `float cosHorizon = - sqrt (height * (height + 2.0 * context. earthRadius )) / (context. earthRadius + height);` 35 `float cosViewAngle ;` 36 `if (texCoords.y > 0.5)` 37 `{` 38 `texCoords.y = saturate (( texCoords.y - (0.5 + 0.5 / context. resolutionView ))) * context. resolutionView / (context. resolutionView / 2.0 - 1.0);` 39 `texCoords.y = pow (texCoords.y, 5.0);` 40 `cosViewAngle = max (( cosHorizon + texCoords.y * (1 - cosHorizon )), cosHorizon + 1e-4) ;` 41 `}` 42 `else` 43 `{` 44 `texCoords.y = saturate (( texCoords.y - 0.5 / context. resolutionView )) * context. resolutionView / (context. resolutionView / 2.0 - 1.0);` 45 `texCoords.y = pow (texCoords.y, 5);` 46 `cosViewAngle = min (( cosHorizon - texCoords.y*( cosHorizon - (-1))), cosHorizon -1e -4);` 47 `}` 48 `cosViewAngle = clamp (cosViewAngle , -1.0, 1.0);` 49 50 `// Parameterization for sun angle` 51 `float cosSunAngle = tan ((2.0 * texCoords.z - 1. + 0.26) * 0.75) / tan (1.26 * 0.75);` 52 `cosSunAngle = clamp (cosSunAngle , -1.0, 1.0);` 53 54 `SkyLutParameter output = ( SkyLutParameter )0;` 55 `output.height = height;` 56 `output. cosViewAngle = cosViewAngle ;` 57 `output. cosSunAngle = cosSunAngle ;` 58 `return output;` 59 `}` 

Listing 5: Unoptimized reference code for physically based sky look-up table mapping. 

59 

## **B Sun limb darkening astro-physical models** 

We present the implementation of two astro-physical models representing the sun limb darkening model. In these models: 

- **centerToEdge** : normalised distance from center to edge of the sun. 

- **finalLuminance** : the final sun luminance contribution to the pixel. 

1 2 `// Model from http :// www.physics.hmc.edu/faculty/esin/a101/ limbdarkening .pdf` 3 `float3 u = float3 (1.0 , 1.0, 1.0); // some models have u!=1` 4 `float3 a = float3 (0.397 , 0.503 , 0.652); // coefficient for RGB wavelength (680 ,550 ,440)` 5 6 `centerToEdge = 1.0 - centerToEdge ;` 7 `float mu = sqrt (1.0 - centerToEdge * centerToEdge );` 8 9 `float3 factor = 1.0 - u * (1.0 - pow (mu , a));` 10 `finalLuminance *= factor;` 

Listing 6: Sun limb darkening model according to [Nec96]. 

1 2 `// Model using P5 polynomial from http :// articles.adsabs.harvard.edu/cgi -bin/nph - iarticle_query ?1994 SoPh ..153...91 N& defaultprint =YES&filetype =. pdf` 3 4 `centerToEdge = 1.0 - centerToEdge ;` 5 `float mu = sqrt (1.0 - centerToEdge * centerToEdge );` 6 7 `// coefficient for RGB wavelength (680 ,550 ,440)` 8 `float3 a0 = float3 ( 0.34685 , 0.26073 , 0.15248);` 9 `float3 a1 = float3 ( 1.37539 , 1.27428 , 1.38517);` 10 `float3 a2 = float3 ( -2.04425 , -1.30352 , -1.49615);` 11 `float3 a3 = float3 ( 2.70493 , 1.47085 , 1.99886);` 12 `float3 a4 = float3 ( -1.94290 , -0.96618 , -1.48155);` 13 `float3 a5 = float3 ( 0.55999 , 0.26384 , 0.44119);` 14 15 `float mu2 = mu*mu;` 16 `float mu3 = mu2*mu;` 17 `float mu4 = mu2*mu2;` 18 `float mu5 = mu4*mu;` 19 20 `float3 factor = a0 + a1*mu + a2*mu2 + a3*mu3 + a4*mu4 + a5*mu5;` 21 `finalLuminance *= factor;` 

Listing 7: Sun limb darkening model according to [HM98]. 

60 

## **C Energy-conserving analytical scattering integration** 

We give more details about the energy-conserving scattered light integration equation presented and discussed in Section 5.6.3. The function basically gives the amount of light scattered out of a slab of homogeneous participating media of depth _d_ = _b − a_ , assuming a uniform incoming light to scatter _S_ and extinction _σt_ . 

**==> picture [346 x 152] intentionally omitted <==**

Here is the mathematical proof of this result (where line 3 is obtained using the fact that exp ( _u_ ) _[′]_ = _u[′]_ exp ( _u_ )): 

Using exp ( _u_ ) _[′]_ = _u[′]_ exp ( _u_ ) _,_ 

**==> picture [247 x 86] intentionally omitted <==**

Section 5.6.3 present improvements resulting from using this energy formulation of scattering for cloud rendering. Figure 53 present how it is useful for the more general participating media rendering use case presented in [Hil15]. 

Figure 53: When increasing _σs_ , a participating media material should converge towards looking like a solid material. However, integrating scattered light without equation 23 using an iterative approach can result in too much energy send back to the camera as shown in Section 5.6 (from left to right: _σs_ = 5, _σs_ = 50 and _σs_ = 5000). Using energy-conserving scattering equation 23 the thick participating media cube on the right having _σs_ = 5000 is looking more like perfect diffuse surface which is expected when using a uniform phase function. 

61 

## **D Tile-able volume noise library** 

We have presented important noise type required for the rendering of volumetric cloud in Section 5.4. We provide the source code to such functions: 

1. https://github.com/sebh/TileableVolumeNoise 

2. Multiple octaves of volume Worley noise (Marc-Andre Loyer) 

3. Multiple octaves of volume Perlin noise using GLM [Ric] 

4. Perlin-Worley noise as described in [Sch15] 

62 

